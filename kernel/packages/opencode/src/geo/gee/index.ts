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

/* --- GeoCode: the GEE lifecycle (docs/GEOKERNEL.md §5.1, §5.7).
 *
 * Sole writer of the status slot. The three facts come from sources that know nothing of each other — a local
 * probe, Net's verdict, the remote authorization check — and each is published the moment it settles rather than
 * waiting for the others; their priority lives in `compose` as a pure function. --- */

/** The endpoint whose reachability decides whether Earth Engine is usable. */
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

/**
 * How long a rejected conclusion is reused before the remote is asked again (§5.5 退避). Short because a tool
 * retry does not clear it while setup is ready — a user who has just enabled the interface waits it out.
 */
const FAILURE_BACKOFF_MS = 30_000

export interface Interface {
  /** Re-probe the local chain if the state is one a retry can fix; answers whether a probe actually started. */
  readonly recheck: () => Effect.Effect<boolean>
  /** The remote conclusion, computed only if not already cached — a credentialed call costing seconds (§5.5). */
  readonly validate: () => Effect.Effect<GeoEvent.GeeRuntime>
  /**
   * Report that a real run was refused (§5.5). Nothing polls a conclusion sitting on "valid", so the user's own
   * call is what corrects it. Answers whether the message was an authorization rejection at all.
   */
  readonly reject: (message: string) => Effect.Effect<boolean>
  /** The readiness question, answered with a verified environment; a refusal carries the status (§9.1, §5.6). */
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

    /**
     * The token of the round currently in charge. The remote check reuses it instead of claiming one of its own:
     * a claim supersedes the running network watch's token, and every later reachability change would then fail
     * to commit.
     */
    let currentToken = yield* writer.claim()

    const publish = (token: GeoStatus.Token) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(facts)
        return yield* writer.commit(token, GeeCompose.compose(current.setup, current.network, current.runtime))
      })

    /** The remote conclusion with the route it was reached over — over another route it no longer applies (§5.5). */
    let cached: { readonly route: string | undefined; readonly conclusion: GeoEvent.GeeRuntime } | undefined
    /** When a failed conclusion stops being reused (§5.5 退避). */
    let backoffUntil = 0
    /**
     * Counts refusals reported from real runs. The check takes seconds, so a refusal can arrive while one is in
     * flight, and without this a probe's older "valid" would land on top of it — §5.5 ranks it the other way.
     */
    let refusals = 0

    /** The network watch, alive exactly while setup is ready (§5.4 idle 的含义). */
    let watching: Fiber.Fiber<void, never> | undefined

    const stopWatching = Effect.gen(function* () {
      if (!watching) return
      // Interrupting drops the subscription, and Net stops probing a target nobody asks about (§3.3 按需驱动).
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

    /**
     * What a network verdict does to the remote conclusion (§5.7). Reachability is no evidence about
     * authorization, so this never triggers a check; it only asks whether the conclusion we have still applies,
     * and returning to the same route — after an outage included — means it does.
     */
    function onNetwork(network: GeoEvent.GeeNetwork): GeoEvent.GeeRuntime {
      if (network.status !== "reachable") return { status: "unknown" }
      if (cached && cached.route === network.route) return cached.conclusion
      return { status: "unknown" }
    }

    const body = (state: MachineConfig.BlockState<"gee">, token: GeoStatus.Token) =>
      Effect.gen(function* () {
        // Everything downstream of the local chain stops being current (§5.7 setup 离开 ready): the watch belongs
        // to a setup that was ready, and the cached conclusion verified a project and credentials about to be
        // re-read.
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

        // Only ready opens the subscription — probing while the local chain is broken helps nobody (§5.4).
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

    // One round at a time: interrupting awaits the previous round's exit, so a superseded round cannot write after
    // the new one started, and the generation token is the second line of defence (§3.4). Serialized because two
    // callers enter here — the config stream and a tool retry — and the handover reads and writes `running` across
    // an await, so interleaved entries leave a forked round nobody holds a handle to interrupt.
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

    /**
     * The environment the check runs in. Unlike the setup probe, which is deliberately offline, this one makes a
     * real remote call, so it carries Net's route in subprocess form (§5.9, §3.3). The project travels as an
     * environment variable, which is where the runtime library reads it too.
     */
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
          // Nothing to ask about, and nothing to ask over: both are answered by the layers below (§5.7).
          if (current.setup.status !== "ready") return current.runtime
          if (current.network.status !== "reachable") return current.runtime

          // The round this answer belongs to: the call takes seconds, and a configuration edit inside that window
          // starts a new round, whose status must not be overwritten with an answer about the project it replaced.
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

          // Superseded while we were asking: the caller still gets its answer, but the answer describes a
          // configuration the system has moved on from, so it goes neither into the cache nor onto the wire.
          if (token !== currentToken) return conclusion
          // Overtaken by a real refusal, which outranks anything we probed — returned, not recorded
          // (§5.5 真实使用兜底).
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
        // Only what we can attribute: a script that failed on its own logic must not invalidate a good
        // authorization — every real use is an answer, but not every failure is a verdict.
        if (!GeeValidate.isRemoteRefusal(message)) return false

        const current = yield* Ref.get(facts)
        const route = current.network.status === "reachable" ? current.network.route : undefined
        const conclusion: GeoEvent.GeeRuntime = {
          status: "failed",
          reason: GeeValidate.classify(message),
          message,
        }
        // The user's own call is the same operation against the same remote, so it outranks a probe in flight
        // (§5.5 真实使用兜底).
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

/**
 * Net's verdict in this module's vocabulary, read and never computed (§8.3). No default: a state added to Net
 * should stop the build here rather than fall into `idle`, the one state meaning nothing is watching.
 */
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
