export * as GeoNet from "./index"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { NetClassifier } from "./classifier"
import { NetDiscovery } from "./discovery"
import { NetMonitor } from "./monitor"
import { NetProbe } from "./probe"
import { NetResolver } from "./resolver"
import { NetRoute } from "./route"
import { routeId, type Reachability, type Route, type Target } from "./types"

export { NetRedact } from "./redact"
export { NetRoute } from "./route"
export * from "./types"

/* --- GeoCode: the Net module of GeoKernel's infrastructure layer
 * (docs/GEOKERNEL.md §3.3). The ONLY place network reachability is decided.
 *
 * Everything about the network lives here: how a path is resolved, when to
 * probe, how to probe, how often to re-verify, what makes a verdict change, and
 * how recovery happens. Capability modules read the conclusion and reproduce
 * none of it (§8.3) — a rule that only survives if there is nothing left for
 * them to reproduce.
 *
 * Net starts no subprocesses. All probing is socket work in this process, which
 * is what makes the four infrastructure modules mutually independent (§2.3) and
 * follows from the decision not to read the operating system's proxy settings
 * (§12) — the one thing that would have needed one. --- */

export interface Change {
  readonly target: string
  readonly state: Reachability
}

export interface Interface {
  /** Declare a target whose connectivity matters. */
  readonly register: (target: Target) => Effect.Effect<void>
  /** Current connectivity of a target. */
  readonly status: (id: string) => Effect.Effect<Reachability>
  /**
   * Current connectivity followed by every change.
   *
   * Subscribing is what starts the monitoring; when the last subscriber goes
   * away it stops. Nothing probes on behalf of a target nobody is asking about
   * (§3.3 按需驱动).
   */
  readonly watch: (id: string) => Stream.Stream<Reachability>
  /** The route in use for a target, if it currently has one. */
  readonly route: (id: string) => Effect.Effect<Route | undefined>
  /**
   * A usable proxy on this machine, if there is one.
   *
   * The whole of Net's involvement for a consumer that picks its own servers.
   * Net answers "does this machine have a proxy" — a fact about the machine,
   * settled by asking a short fixed list of loopback addresses one protocol
   * question each, and verified rather than assumed: a declared variable can
   * name a proxy that stopped running months ago, and something answering on a
   * conventional port may just be a development server.
   *
   * It says nothing about WHICH server to ask or in what order. A consumer with
   * its own opinion about its endpoints — a reference deployment it prefers,
   * mirrors it falls back to — keeps that opinion, and only needs to know how to
   * get out of the building.
   */
  readonly proxy: (target: Target) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoNet") {}

export const use = serviceUse(Service)

interface Entry {
  readonly target: Target
  machine: NetMonitor.Machine
  route?: Route
  watchers: number
  loop?: Fiber.Fiber<void, never>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<Change>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

    // Monitor loops belong to the MODULE's lifetime, not to whoever happened to
    // start one. Two consumers watching the same target must not put the same
    // loop on two different clocks; the watcher count decides when it runs, and
    // this decides where it lives.
    const scope = yield* Effect.scope

    const entries = new Map<string, Entry>()

    const publish = (entry: Entry) => PubSub.publish(pubsub, { target: entry.target.id, state: entry.machine.state })

    /**
     * One round of probing for a target.
     *
     * Returns the route alongside the verdict so the caller never has to
     * resolve a second time to find out which path just worked — resolving is
     * real handshakes, and doing them twice per round would double the cost of
     * every recovery.
     */
    const probeOnce = (entry: Entry) =>
      Effect.promise(async (): Promise<{ verdict: NetMonitor.Verdict; route?: Route }> => {
        // The cheapest question first, and the only one that costs no network at
        // all: does this machine have anywhere to send a packet? Asking the
        // operating system takes microseconds and no traffic, so a laptop with
        // its radio off — or one on a plane — spends nothing at all while it
        // waits, instead of opening a socket every round to be told the same
        // thing. It is also the unambiguous signal that skips hysteresis (§3.3).
        if (!NetClassifier.hasNetworkInterface()) {
          return { verdict: { ok: false, kind: "offline", detail: "no network interface is up" } }
        }

        // Route-aware re-verification: a held direct route is re-tested
        // directly, a held proxy route is re-tested as "can this proxy still
        // reach the target". A user losing their connection and a user closing
        // their proxy software therefore travel the same detection path and
        // differ only in where they fail (§3.3).
        const held = entry.route
        if (!NetMonitor.shouldRediscover(entry.machine) && held) {
          const result =
            held.kind === "direct"
              ? await NetProbe.direct(entry.target)
              : await NetProbe.viaProxy(entry.target, held.url)
          if (result.ok) return { verdict: { ok: true, routeId: routeId(held) }, route: held }
          return { verdict: { ok: false, kind: NetClassifier.classify(result.reason), detail: result.reason } }
        }

        // No route in hand, so search from scratch: this is what picks up a
        // proxy the user has only just started, with nothing to click.
        const resolution = await NetResolver.resolve(entry.target)
        if (resolution.ok) return { verdict: { ok: true, routeId: resolution.routeId }, route: resolution.route }
        return { verdict: { ok: false, kind: NetClassifier.classify(resolution.reason), detail: resolution.reason } }
      })

    const applyVerdict = (entry: Entry, verdict: NetMonitor.Verdict) =>
      Effect.gen(function* () {
        const before = entry.machine.state
        entry.machine = NetMonitor.step(entry.machine, verdict)
        if (!verdict.ok) entry.route = entry.machine.state.state === "reachable" ? entry.route : undefined
        // Publishing only on real change keeps a steady network silent (§3.4).
        if (!isDeepStrictEqual(before, entry.machine.state)) yield* publish(entry)
      })

    const runLoop = (entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          // A probe that throws is not a probe that failed — without this the
          // defect propagates and takes the loop's fiber with it, so one bad
          // target would silently end monitoring for good. Treated as an
          // ambiguous failure, which is what it is: we learned nothing.
          const round = yield* probeOnce(entry).pipe(
            Effect.catchDefect(
              (defect): Effect.Effect<{ verdict: NetMonitor.Verdict; route?: Route }> =>
                Effect.succeed({
                  verdict: {
                    ok: false,
                    kind: "other",
                    detail: defect instanceof Error ? defect.message : String(defect),
                  },
                }),
            ),
          )
          if (round.verdict.ok) entry.route = round.route
          yield* applyVerdict(entry, round.verdict)
          yield* Effect.sleep(NetMonitor.interval(entry.machine))
        }
      })

    const acquire = (id: string) =>
      Effect.gen(function* () {
        const entry = entries.get(id)
        if (!entry) return
        entry.watchers += 1
        if (entry.watchers > 1 || entry.loop) return
        entry.machine = { state: { state: "checking" }, streak: 0 }
        yield* publish(entry)
        entry.loop = yield* Effect.forkIn(runLoop(entry), scope)
      })

    const release = (id: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = entries.get(id)
        if (!entry) return
        entry.watchers = Math.max(0, entry.watchers - 1)
        if (entry.watchers > 0) return
        const loop = entry.loop
        entry.loop = undefined
        if (loop) yield* Fiber.interrupt(loop)
        entry.machine = NetMonitor.initial
        entry.route = undefined
      })

    const register = (target: Target) =>
      Effect.sync(() => {
        if (entries.has(target.id)) return
        entries.set(target.id, { target, machine: NetMonitor.initial, watchers: 0 })
      })

    const status = (id: string): Effect.Effect<Reachability> =>
      Effect.sync(() => entries.get(id)?.machine.state ?? { state: "idle" })

    const route = (id: string) => Effect.sync(() => entries.get(id)?.route)

    const proxy = (target: Target) =>
      Effect.promise(async () => (await NetDiscovery.candidates(target))[0]).pipe(
        // Discovery opens sockets, and a socket layer that raises where it is
        // documented to resolve would otherwise become a defect — outside the
        // error type, taking the caller down over a question whose honest
        // answer is simply "then we know of no proxy".
        Effect.catchDefect(() => Effect.succeed(undefined)),
      )

    const watch = (id: string): Stream.Stream<Reachability> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading, for the reason §9.2 gives: the reverse
          // loses any change landing between the two calls.
          const subscription = yield* PubSub.subscribe(pubsub)
          yield* Effect.acquireRelease(acquire(id), () => release(id))
          const current = entries.get(id)?.machine.state ?? { state: "idle" as const }
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.target === id),
            Stream.map((change) => change.state),
          )
          return Stream.make(current).pipe(Stream.concat(live))
        }),
      )

    return Service.of({ register, status, watch, route, proxy })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/** Re-exported so consumers reach the two route forms through one import. */
export const subprocessEnv = NetRoute.subprocessEnv
export const agent = NetRoute.agent
