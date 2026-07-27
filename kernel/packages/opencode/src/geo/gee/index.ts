export * as GeeService from "./index"

import { Clock, Context, Effect, Fiber, Layer, Ref, Semaphore, Stream } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { MachineConfig } from "../config"
import { GeoNet } from "../net"
import type { NetTypes } from "../net/types"
import { GeoRuntime } from "../runtime"
import { GeoStatus } from "../status"
import { GeeCompose } from "./compose"
import { GeeSetup } from "./setup"

export { GeeDeps } from "./deps"

/* --- GeoCode: the GEE lifecycle (docs/GEOKERNEL.md §5.1, §5.7).
 *
 * Owns the status slot and is its only writer. Three facts arrive from three
 * places that know nothing of each other — a local probe, Net's verdict, and
 * (from 3c) the remote authorization check — and each is published the moment
 * it settles rather than waiting for the others.
 *
 * The layer order is not an implementation detail: local before network before
 * remote is what keeps the user facing one problem at a time, and it lives in
 * `compose` as a pure function so it stays that way. --- */

/**
 * The endpoint whose reachability decides whether Earth Engine is usable.
 *
 * ONE target, not a group. A group exists to rank interchangeable endpoints
 * against each other; these are not interchangeable — every request goes to
 * this host, and any other address would only ever be a stand-in for probing.
 */
export const TARGET: NetTypes.Target = {
  id: "gee",
  host: "earthengine.googleapis.com",
  port: 443,
}

/**
 * The setup states a retry is allowed to re-probe (§5.8).
 *
 * What they have in common: the user can fix them WITHOUT touching the config
 * file — install a package, run the authentication command — and none of those
 * actions is something the file watcher can see. A tool retry is the only
 * signal that the world may have changed, so it is treated as one.
 *
 * `unconfigured` and `project-missing` are deliberately absent: both are fixed
 * by editing the config, and that path is already watched. Re-probing on them
 * would be a second trigger for an event we already receive.
 */
const SELF_HEALING: ReadonlySet<GeoEvent.GeeSetup["status"]> = new Set([
  "python-missing",
  "packages-missing",
  "credentials-missing",
  "probe-timeout",
  "probe-failed",
])

/**
 * How close together two forced re-probes may be.
 *
 * Leading edge: the first retry probes immediately — someone who just finished
 * installing a package should not wait — while a burst behind it collapses
 * into that one probe instead of a subprocess per retry.
 */
const RECHECK_DEBOUNCE_MS = 3_000

export interface Interface {
  /**
   * Re-probe the local chain if the current state is one a retry can fix.
   *
   * Answers whether a probe was actually started, so a caller can tell "I
   * looked again" from "there was nothing to look at".
   */
  readonly recheck: () => Effect.Effect<boolean>
}

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
      // The remote layer is 3c's. Until then it is honestly unknown: nothing
      // has asked the remote anything, and §5.5 says nothing should, until a
      // conclusion is actually needed.
      runtime: { status: "unknown" } as GeoEvent.GeeRuntime,
    }
    const facts = yield* Ref.make(initial)
    const writer = yield* status.register("gee", GeeCompose.compose(initial.setup, initial.network, initial.runtime))

    /**
     * Publish under a token.
     *
     * Every write goes through here so the composition is applied exactly
     * once, in one place — a caller that assembled its own status object could
     * disagree with `facing` and nobody would notice.
     */
    const publish = (token: GeoStatus.Token) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(facts)
        return yield* writer.commit(token, GeeCompose.compose(current.setup, current.network, current.runtime))
      })

    /** The network watch, alive exactly while setup is ready (§5.4 idle 的含义). */
    let watching: Fiber.Fiber<void, never> | undefined

    const stopWatching = Effect.gen(function* () {
      if (!watching) return
      // Interrupting drops our subscription, and Net stops probing a target
      // nobody is asking about (§3.3 按需驱动). That is the whole mechanism
      // behind "idle": not a flag we set, but monitoring that is not running.
      yield* Fiber.interrupt(watching)
      watching = undefined
    })

    const startWatching = (token: GeoStatus.Token) =>
      Effect.gen(function* () {
        yield* net.register(TARGET)
        watching = yield* Effect.forkIn(
          Stream.runForEach(net.watch(TARGET.id), (reachability) =>
            Effect.gen(function* () {
              yield* Ref.update(facts, (current) => ({ ...current, network: toNetwork(reachability) }))
              yield* publish(token)
            }),
          ),
          scope,
        )
      })

    const body = (state: MachineConfig.BlockState<"gee">, token: GeoStatus.Token) =>
      Effect.gen(function* () {
        // A new round means the previous conclusion about the local chain is
        // being redone, and everything downstream of it stops being current:
        // the network watch belongs to a setup that was ready, and the remote
        // conclusion belonged to that same environment (§5.7 setup 离开 ready).
        yield* stopWatching
        yield* Ref.update(facts, (current) => ({
          ...current,
          setup: { status: "checking" } as GeoEvent.GeeSetup,
          network: { status: "idle" } as GeoEvent.GeeNetwork,
          runtime: { status: "unknown" } as GeoEvent.GeeRuntime,
        }))
        yield* publish(token)

        // A syntax error is not "unconfigured": the file says something, we
        // just cannot read it, and showing an empty configuration would
        // contradict what the user is looking at (§3.1, §8.1).
        const setup: GeoEvent.GeeSetup = state.ok
          ? yield* GeeSetup.probe(runtime, state.value)
          : { status: "probe-failed", error: `machine.json could not be read: ${state.failure.message}` }

        yield* Ref.update(facts, (current) => ({ ...current, setup }))
        yield* publish(token)

        // Ready is what opens the subscription — and only ready. Watching
        // while the local chain is broken would spend probes on a fact nobody
        // can act on yet (§5.4).
        if (setup.status === "ready") yield* startWatching(token)
      })

    const round = (state: MachineConfig.BlockState<"gee">) =>
      Effect.gen(function* () {
        const token = yield* writer.claim()
        yield* body(state, token).pipe(
          // A defect must not strand the slot mid-probe with nobody reporting
          // anything. Interruption is not a defect and passes through — a
          // superseded round simply stops.
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

    // One round at a time. Interrupting awaits the previous round's exit, so a
    // superseded round cannot write after the new one has started; the
    // generation token is the second line of defence (§3.4).
    //
    // Serialized because there are TWO ways in — the config stream and a tool
    // retry — and the handover reads and writes `running` across an await. Two
    // interleaved entries can leave a round nobody holds a handle to: it keeps
    // probing, and the network watch it opened is never the one the next round
    // stops, so that subscription outlives every round and keeps Net working
    // on a target with no reader.
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

    return Service.of({ recheck })
  }),
)

/**
 * Net's verdict, in this module's vocabulary. Read, never computed (§8.3).
 *
 * Exhaustive on purpose — no default. A state added to Net's vocabulary should
 * stop the build here and be answered deliberately, not fall silently into
 * "idle", which happens to be the one state that means "nothing is watching".
 */
function toNetwork(reachability: NetTypes.Reachability): GeoEvent.GeeNetwork {
  switch (reachability.state) {
    case "reachable":
      return { status: "reachable", route: reachability.route }
    case "unreachable":
      return { status: "unreachable" }
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
