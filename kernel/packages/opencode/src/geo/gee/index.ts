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
import { GeeValidate } from "./validate"

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

/**
 * How long a rejected conclusion is reused before the remote is asked again
 * (§5.5 退避).
 *
 * Bounds the cost of a caller that keeps trying: without it, an agent
 * retrying a script five times would spend five credentialed calls to be told
 * the same thing. Short enough that a user who has just enabled the interface
 * or re-authenticated is not left waiting on a stale verdict — and the two
 * fixes that change configuration do not wait at all, since a config change
 * drops the cache outright.
 */
const FAILURE_BACKOFF_MS = 30_000

export interface Interface {
  /**
   * Re-probe the local chain if the current state is one a retry can fix.
   *
   * Answers whether a probe was actually started, so a caller can tell "I
   * looked again" from "there was nothing to look at".
   */
  readonly recheck: () => Effect.Effect<boolean>
  /**
   * The remote conclusion, computed only if it is not already known (§5.5).
   *
   * Lazy on purpose: this is the one call that carries credentials and enters
   * the remote's quota visibility, so it happens when an answer is needed and
   * at no other time. A cached conclusion reached over the route still in use
   * is returned without any call at all.
   */
  readonly validate: () => Effect.Effect<GeoEvent.GeeRuntime>
  /**
   * Report that a real run was refused, and let that close the loop (§5.5).
   *
   * The cache can sit on "valid" indefinitely — credentials get revoked
   * without the route changing — and no amount of polling would be worth what
   * it costs. Instead the user's own call is the check: it is the same
   * operation against the same remote. Answers whether the message was an
   * authorization rejection at all; anything else leaves the conclusion alone.
   */
  readonly reject: (message: string) => Effect.Effect<boolean>
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
      // Honestly unknown until someone needs an answer: nothing has asked the
      // remote anything, and §5.5 says nothing should until a conclusion is
      // actually required.
      runtime: { status: "unknown" } as GeoEvent.GeeRuntime,
    }
    const facts = yield* Ref.make(initial)
    const writer = yield* status.register("gee", GeeCompose.compose(initial.setup, initial.network, initial.runtime))

    /**
     * The token of the round currently in charge.
     *
     * A token identifies a ROUND, and claiming one supersedes whatever came
     * before — which is exactly right for the round body and for the network
     * watch it started, since both stop being current when the configuration
     * is re-read. The remote check is NOT a round: it answers a question
     * inside the round that is already running. If it claimed a token of its
     * own it would silently supersede the live network watch, and every
     * subsequent reachability change would be dropped on the floor.
     */
    let currentToken = yield* writer.claim()

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

    /**
     * The remote conclusion, and the route it was reached over (§5.5).
     *
     * A single entry, not a table: the rule is "re-ask when the identity is
     * different", and one entry answers that. Two exits alternating would
     * re-ask on each switch, which is the correct answer to a genuinely
     * changed path, not a cache miss worth engineering around.
     *
     * Dropped whenever a round starts, because the conclusion is about THIS
     * configuration — the project identifier is half of what it verified.
     */
    let cached: { readonly route: string | undefined; readonly conclusion: GeoEvent.GeeRuntime } | undefined
    /** When a failed conclusion stops being reused (§5.5 退避). */
    let backoffUntil = 0

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
              const network = toNetwork(reachability)
              yield* Ref.update(facts, (current) => ({ ...current, network, runtime: onNetwork(network) }))
              yield* publish(token)
            }),
          ),
          scope,
        )
      })

    /**
     * What a network verdict does to the remote conclusion (§5.7).
     *
     * Reachability changing is NOT evidence about authorization: credentials
     * do not expire because a link flapped, and a project does not come
     * unbound. So this never triggers a check — it only decides whether the
     * conclusion we already have still applies.
     *
     * The rule here reads "the identity is DIFFERENT", and that is deliberately
     * not the rule the ranking uses (§3.3), where any change — including gone
     * and came back — invalidates. Ranking measures latency, which loses its
     * reference the moment the link drops. Authorization does not: leaving and
     * returning to the same exit means the same conclusion still holds, and
     * re-asking would spend a credentialed call to learn what we knew.
     */
    function onNetwork(network: GeoEvent.GeeNetwork): GeoEvent.GeeRuntime {
      if (network.status !== "reachable") return { status: "unknown" }
      // Back on the route the conclusion was reached over — including after an
      // outage — so it stands, at no cost.
      if (cached && cached.route === network.route) return cached.conclusion
      return { status: "unknown" }
    }

    const body = (state: MachineConfig.BlockState<"gee">, token: GeoStatus.Token) =>
      Effect.gen(function* () {
        // A new round means the previous conclusion about the local chain is
        // being redone, and everything downstream of it stops being current:
        // the network watch belongs to a setup that was ready, and the remote
        // conclusion belonged to that same environment (§5.7 setup 离开 ready).
        yield* stopWatching
        // The cached conclusion goes with it: it verified a project identifier
        // and a set of credentials that this round is about to re-read.
        cached = undefined
        backoffUntil = 0
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
        currentToken = token
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

    /**
     * Serialized so a burst of callers produces at most one remote call. This
     * layer exists to keep credentialed calls rare; letting two arrive
     * together would undo that in the one place it matters most.
     */
    const asking = Semaphore.makeUnsafe(1)

    /**
     * The environment the check runs in.
     *
     * Opposite of the setup probe, which is deliberately offline: this one
     * makes a real remote call, so it takes Net's route in the subprocess form
     * Net defines (§5.9, §3.3). The project travels as an environment variable
     * rather than inside the script, which is also how the runtime library
     * picks it up later.
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
          // Nothing to ask about, and nothing to ask over. Both are answered
          // by the layers below, and asking anyway would put a credentialed
          // call behind a question the user cannot act on (§5.7).
          if (current.setup.status !== "ready") return current.runtime
          if (current.network.status !== "reachable") return current.runtime

          // The round this answer will belong to. The remote call takes
          // seconds, and a configuration edit inside that window starts a new
          // round which clears the cache — without this, the answer about the
          // project the user just replaced would be written back on top,
          // leaving the status describing a configuration that no longer
          // exists.
          const token = currentToken
          const route = current.network.route
          if (cached && cached.route === route) {
            // A failed conclusion is reused until its backoff expires, so a
            // caller retrying in a loop does not become a remote call per try.
            const now = yield* Clock.currentTimeMillis
            if (cached.conclusion.status !== "failed" || now < backoffUntil) return cached.conclusion
          }

          yield* Ref.update(facts, (state) => ({ ...state, runtime: { status: "checking" } as GeoEvent.GeeRuntime }))
          yield* publish(token)

          const conclusion = yield* GeeValidate.run(runtime, current.setup.python, yield* remoteEnv(current), route)

          // Superseded while we were asking. The caller still gets the answer
          // it waited for — it is a true answer about what it asked — but it
          // describes a configuration the system has moved on from, so it goes
          // neither into the cache nor onto the wire.
          if (token !== currentToken) return conclusion

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
        // Only what we can attribute. A script that failed on its own logic
        // must not invalidate a perfectly good authorization — the loop is
        // "every real use is an answer", not "every failure is a verdict".
        if (!GeeValidate.isRejection(message)) return false

        const current = yield* Ref.get(facts)
        const route = current.network.status === "reachable" ? current.network.route : undefined
        const conclusion: GeoEvent.GeeRuntime = {
          status: "failed",
          reason: GeeValidate.classify(message),
          message,
        }
        // Evidence from the user's own call outranks anything we probed: it is
        // the same operation, against the same remote, with the same
        // credentials (§5.5 真实使用兜底).
        cached = { route, conclusion }
        backoffUntil = (yield* Clock.currentTimeMillis) + FAILURE_BACKOFF_MS
        yield* Ref.update(facts, (state) => ({ ...state, runtime: conclusion }))
        yield* publish(currentToken)
        return true
      })

    return Service.of({ recheck, validate, reject })
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
