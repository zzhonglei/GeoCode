export * as GeeService from "./index"

import { Clock, Context, Effect, Fiber, Layer, Ref, Semaphore, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineConfig } from "../config"
import { GeoNet } from "../net"
import { NetRoute } from "../net/route"
import type { NetTypes } from "../net/types"
import { GeoRuntime } from "../runtime"
import { GeoStatus } from "../status"
import { GeeCompose } from "./compose"
import { GeeSetup } from "./setup"
import type { GeeTypes } from "./types"
import { GeeValidate } from "./validate"

export { GeeDeps } from "./deps"
export { GeeExecutor } from "./executor"
export { GeeGuidance } from "./guidance"
export type { Environment } from "./types"

/* --- GeoCode: the GEE lifecycle, sole writer of the `gee` status slot, publishing each fact the moment it settles
 * (docs/GEOKERNEL.md §5.7). --- */

export const TARGET: NetTypes.Target = {
  id: "gee",
  host: "earthengine.googleapis.com",
  port: 443,
}

/** Setup states a tool retry re-probes: each can be fixed without touching the config, which is watched (§5.8). */
const SELF_HEALING: ReadonlySet<GeoEvent.GeeSetup["status"]> = new Set([
  "python-missing",
  "packages-missing",
  "credentials-missing",
  "probe-timeout",
  "probe-failed",
])

/** Leading edge: the first retry probes at once, and a burst behind it collapses into that one probe. */
const RECHECK_DEBOUNCE_MS = 3_000

/** Short because a tool retry does not clear it while setup is ready: a user who just enabled the API waits it out. */
const FAILURE_BACKOFF_MS = 30_000

export interface Interface {
  /** Re-probe the local chain if the state is one a retry can fix; answers whether a probe actually started. */
  readonly recheck: () => Effect.Effect<boolean>
  /** The remote conclusion, computed only if not already cached — a credentialed call costing seconds (§5.5). */
  readonly validate: () => Effect.Effect<GeoEvent.GeeRuntime>
  /**
   * Report that a real run was refused; nothing polls a cached "valid", so this is what corrects it. Answers whether
   * the message was an authorization rejection at all.
   */
  readonly reject: (message: string) => Effect.Effect<boolean>
  readonly gate: () => Effect.Effect<Gate>
}

export type Gate =
  | { readonly ok: true; readonly environment: GeeTypes.Environment }
  | { readonly ok: false; readonly status: GeoEvent.GeeStatus }

export class Service extends Context.Service<Service, Interface>()("@geocode/GeeService") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MachineConfig.Service
    const status = yield* GeoStatus.Service
    const runtime = yield* GeoRuntime.Service
    const net = yield* GeoNet.Service
    const scope = yield* Effect.scope

    const initial = {
      setup: { status: "unconfigured" } as GeoEvent.GeeSetup,
      network: { status: "idle" } as GeoEvent.GeeNetwork,
      runtime: { status: "unknown" } as GeoEvent.GeeRuntime,
    }
    const facts = yield* Ref.make(initial)
    const writer = yield* status.register("gee", GeeCompose.compose(initial.setup, initial.network, initial.runtime))

    /** The remote check reuses this rather than claiming: a claim would supersede the network watch's token. */
    let currentToken = yield* writer.claim()

    const publish = (token: GeoStatus.Token) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(facts)
        return yield* writer.commit(token, GeeCompose.compose(current.setup, current.network, current.runtime))
      })

    /** The remote conclusion with the route it was reached over — over another route it no longer applies (§5.5). */
    let cached: { readonly route: string | undefined; readonly conclusion: GeoEvent.GeeRuntime } | undefined
    let backoffUntil = 0
    /** Lets a check in flight see that a real refusal landed meanwhile, so its older answer does not overwrite it. */
    let refusals = 0

    /** The network watch, alive exactly while setup is ready. */
    let watching: Fiber.Fiber<void, never> | undefined

    const stopWatching = Effect.gen(function* () {
      if (!watching) return
      // Interrupting drops the subscription, and Net stops probing a target nobody asks about (§3.3).
      yield* Fiber.interrupt(watching)
      watching = undefined
    })

    const startWatching = (token: GeoStatus.Token) =>
      Effect.gen(function* () {
        yield* net.register(TARGET)
        watching = yield* Effect.forkIn(
          Stream.runForEach(net.watch(TARGET.id), (reachability) =>
            Effect.gen(function* () {
              const network = toNetwork(reachability)
              yield* Ref.update(facts, (current) => ({ ...current, network, runtime: onNetwork(network) }))
              yield* publish(token)
            }),
          ),
          scope,
        )
      })

    /** Starts no check: reachability says nothing about authorization, so a cached conclusion holds on its route. */
    function onNetwork(network: GeoEvent.GeeNetwork): GeoEvent.GeeRuntime {
      if (network.status !== "reachable") return { status: "unknown" }
      if (cached && cached.route === network.route) return cached.conclusion
      return { status: "unknown" }
    }

    const body = (state: MachineConfig.BlockState<"gee">, token: GeoStatus.Token) =>
      Effect.gen(function* () {
        // The watch, the cached conclusion and its backoff all belong to the setup about to be re-probed.
        yield* stopWatching
        cached = undefined
        backoffUntil = 0
        yield* Ref.update(facts, (current) => ({
          ...current,
          setup: { status: "checking" } as GeoEvent.GeeSetup,
          network: { status: "idle" } as GeoEvent.GeeNetwork,
          runtime: { status: "unknown" } as GeoEvent.GeeRuntime,
        }))
        yield* publish(token)

        const setup: GeoEvent.GeeSetup = state.ok
          ? yield* GeeSetup.probe(runtime, state.value)
          : { status: "config-error", file: state.failure.file, message: state.failure.message }

        yield* Ref.update(facts, (current) => ({ ...current, setup }))
        yield* publish(token)

        if (setup.status === "ready") yield* startWatching(token)
      })

    const round = (state: MachineConfig.BlockState<"gee">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        currentToken = token
        yield* body(state, token).pipe(
          // A defect must not strand the slot mid-probe with nobody reporting anything; interruption is not a
          // defect and passes through, so a superseded round simply stops.
          Effect.catchDefect((defect) =>
            Effect.gen(function* () {
              yield* Ref.update(facts, (current) => ({
                ...current,
                setup: { status: "probe-failed", error: `lifecycle defect: ${String(defect)}` } as GeoEvent.GeeSetup,
              }))
              yield* Effect.asVoid(publish(token))
            }),
          ),
        )
      })

    // Serialized because the config stream and tool retries both enter, and interleaved handovers would orphan a
    // round; `Fiber.interrupt` awaits the old round's exit, so it cannot write after the new one starts.
    const turn = Semaphore.makeUnsafe(1)
    let running: Fiber.Fiber<void, never> | undefined
    const start = (state: MachineConfig.BlockState<"gee">) =>
      turn.withPermits(1)(
        Effect.gen(function* () {
          if (running) yield* Fiber.interrupt(running)
          running = yield* Effect.forkIn(round(state), scope)
        }),
      )

    yield* Effect.forkIn(Stream.runForEach(config.watch("gee"), start), scope)

    let lastRecheck = 0
    const recheck = () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(facts)
        if (!SELF_HEALING.has(current.setup.status)) return false

        const now = yield* Clock.currentTimeMillis
        if (now - lastRecheck < RECHECK_DEBOUNCE_MS) return false
        lastRecheck = now

        yield* start(yield* config.block("gee"))
        return true
      })

    /** Serialized so a burst of callers produces at most one remote call. */
    const asking = Semaphore.makeUnsafe(1)

    /** Unlike the offline setup probe, this carries Net's route, because whatever runs in it reaches the remote. */
    const remoteEnv = (state: { readonly setup: GeoEvent.GeeSetup }) =>
      Effect.gen(function* () {
        const project = state.setup.status === "ready" ? state.setup.project : ""
        const route = yield* net.route(TARGET.id)
        return {
          ...NetRoute.subprocessEnv(route ?? { kind: "direct" }),
          GEE_PROJECT: project,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "UTF-8",
        }
      })

    const validate = () =>
      asking.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(facts)
          if (current.setup.status !== "ready") return current.runtime
          if (current.network.status !== "reachable") return current.runtime

          // Captured before the call: an edit during it starts a new round, whose status must not receive an answer
          // about the project it replaced.
          const token = currentToken
          const witnessed = refusals
          const route = current.network.route
          if (cached && cached.route === route) {
            // A failed conclusion is reused until its backoff expires, so a retry loop is not a call per try.
            const now = yield* Clock.currentTimeMillis
            if (cached.conclusion.status !== "failed" || now < backoffUntil) return cached.conclusion
          }

          yield* Ref.update(facts, (state) => ({ ...state, runtime: { status: "checking" } as GeoEvent.GeeRuntime }))
          yield* publish(token)

          const conclusion = yield* GeeValidate.run(runtime, current.setup.python, yield* remoteEnv(current), route)

          // Superseded meanwhile: the caller still gets the answer, but it goes neither into the cache nor on the wire.
          if (token !== currentToken) return conclusion
          // Overtaken by a real refusal, which outranks anything we probed — returned, not recorded (§5.5).
          if (refusals !== witnessed) return conclusion

          cached = { route, conclusion }
          if (conclusion.status === "failed") {
            backoffUntil = (yield* Clock.currentTimeMillis) + FAILURE_BACKOFF_MS
          }
          yield* Ref.update(facts, (state) => ({ ...state, runtime: conclusion }))
          yield* publish(token)
          return conclusion
        }),
      )

    const reject = (message: string) =>
      Effect.gen(function* () {
        // Only what we can attribute: a script that failed on its own logic must not invalidate a good authorization.
        if (!GeeValidate.isRemoteRefusal(message)) return false

        const current = yield* Ref.get(facts)
        const route = current.network.status === "reachable" ? current.network.route : undefined
        const conclusion: GeoEvent.GeeRuntime = {
          status: "failed",
          reason: GeeValidate.classify(message),
          message,
        }
        // The user's own call is the same operation against the same remote, so it outranks a probe in flight (§5.5).
        refusals += 1
        cached = { route, conclusion }
        backoffUntil = (yield* Clock.currentTimeMillis) + FAILURE_BACKOFF_MS
        yield* Ref.update(facts, (state) => ({ ...state, runtime: conclusion }))
        yield* publish(currentToken)
        return true
      })

    const gate = (): Effect.Effect<Gate> =>
      Effect.gen(function* () {
        const refuse = Effect.gen(function* () {
          const state = yield* Ref.get(facts)
          return {
            ok: false as const,
            status: GeeCompose.compose(state.setup, state.network, state.runtime),
          }
        })

        const before = yield* Ref.get(facts)
        if (before.setup.status !== "ready" || before.network.status !== "reachable") return yield* refuse

        // The lazy check's other trigger (§5.5): needing to run is needing an answer, and a cached conclusion
        // over the route in use costs nothing.
        const conclusion = yield* validate()
        if (conclusion.status !== "valid") return yield* refuse

        // Re-read: the check took seconds, and handing out an environment assembled from what we read before the
        // wait is the window §4.9 exists to close.
        const after = yield* Ref.get(facts)
        if (after.setup.status !== "ready" || after.network.status !== "reachable") return yield* refuse
        if (after.runtime.status !== "valid") return yield* refuse

        return {
          ok: true as const,
          environment: {
            python: after.setup.python,
            project: after.setup.project,
            version: after.setup.version,
            route: after.network.route,
            env: yield* remoteEnv(after),
          },
        }
      })

    return Service.of({ recheck, validate, reject, gate })
  }),
)

/** No default: a state added to Net should stop the build here rather than fall into `idle`, which means unwatched. */
export function toNetwork(reachability: NetTypes.Reachability): GeoEvent.GeeNetwork {
  switch (reachability.state) {
    case "reachable":
      return { status: "reachable", route: reachability.route }
    case "unreachable":
      // `detail` is the one field that stays behind: it is the raw error, kept as diagnostics (§3.3).
      return {
        status: "unreachable",
        ...(reachability.tried ? { tried: reachability.tried } : {}),
        ...(reachability.skipped ? { skipped: reachability.skipped } : {}),
      }
    case "checking":
      return { status: "checking" }
    case "idle":
      return { status: "idle" }
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MachineConfig.node, GeoStatus.node, GeoRuntime.node, GeoNet.node],
})
