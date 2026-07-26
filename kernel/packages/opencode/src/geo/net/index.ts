export * as GeoNet from "./index"

import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { NetClassifier } from "./classifier"
import { NetDiscovery } from "./discovery"
import { NetMonitor } from "./monitor"
import { NetProbe } from "./probe"
import { NetRanking } from "./ranking"
import { NetResolver } from "./resolver"
import { NetRoute } from "./route"
import { routeId, type RankedEndpoint, type Reachability, type Route, type Target } from "./types"

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
  /**
   * Declare a set of interchangeable endpoints to be ranked.
   *
   * The first endpoint anchors the group: it is the target whose route changes
   * decide when the ranking stops being valid.
   */
  readonly registerGroup: (id: string, endpoints: readonly string[]) => Effect.Effect<void>
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
   * Ranked (endpoint, route) pairs for a group, measured on first request.
   *
   * Holding a ranking keeps the group's anchor monitored, which is how a route
   * change can invalidate it. Losing the ranking releases that.
   */
  readonly ranking: (id: string) => Effect.Effect<readonly RankedEndpoint[]>
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

interface Group {
  readonly endpoints: readonly string[]
  ranked?: readonly RankedEndpoint[]
  /** True while this group's cached ranking is holding the anchor's monitor open. */
  holding: boolean
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<Change>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

    // Monitor loops belong to the MODULE's lifetime, not to whoever happened to
    // start one. A ranking held across many callers and a stream watched by one
    // must not put the same loop on two different clocks; the watcher count
    // decides when it runs, and this decides where it lives.
    const scope = yield* Effect.scope

    const entries = new Map<string, Entry>()
    const groups = new Map<string, Group>()

    const publish = (entry: Entry) => PubSub.publish(pubsub, { target: entry.target.id, state: entry.machine.state })

    /** Discard rankings anchored on this target. */
    const invalidate = (id: string) =>
      Effect.gen(function* () {
        const group = groups.get(id)
        if (!group?.ranked) return
        group.ranked = undefined
        if (group.holding) {
          group.holding = false
          yield* release(id)
        }
      })

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
        // Route-aware re-verification: a held direct route is re-tested
        // directly, a held proxy route is re-tested as "can this proxy still
        // reach the target". A user losing their connection and a user closing
        // their proxy software therefore travel the same detection path and
        // differ only in where they fail (§3.3).
        const held = entry.route
        if (!NetMonitor.shouldRediscover(entry.machine) && held) {
          const result =
            held.kind === "direct" ? await NetProbe.direct(entry.target) : await NetProbe.viaProxy(entry.target, held.url)
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
        const outcome = NetMonitor.step(entry.machine, verdict)
        entry.machine = outcome.next
        if (!verdict.ok) entry.route = entry.machine.state.state === "reachable" ? entry.route : undefined
        if (outcome.invalidateRanking) yield* invalidate(entry.target.id)
        // Publishing only on real change keeps a steady network silent (§3.4).
        if (!isDeepStrictEqual(before, entry.machine.state)) yield* publish(entry)
      })

    const runLoop = (entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const round = yield* probeOnce(entry)
          if (round.verdict.ok) entry.route = round.route
          yield* applyVerdict(entry, round.verdict)
          yield* Effect.sleep(NetMonitor.interval(entry.machine))
        }
      })

    /**
     * Routes worth measuring against: direct, plus any proxy the machine has.
     *
     * Path RESOLUTION is direct-first and only looks for proxies once direct
     * has failed. Ranking is a different question — not "how do I get there"
     * but "which way is quickest" — so it measures every path that exists.
     */
    const availableRoutes = async (anchor?: Target): Promise<Route[]> => {
      const routes: Route[] = [{ kind: "direct" }]
      if (!anchor) return routes
      for (const url of await NetDiscovery.candidates(anchor)) routes.push({ kind: "proxy", url })
      return routes
    }

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

    const registerGroup = (id: string, endpoints: readonly string[]) =>
      Effect.gen(function* () {
        if (groups.has(id) || endpoints.length === 0) return
        // A malformed endpoint must not take the registration down with it: the
        // list is a constant in the consuming module, and a typo there should
        // cost that module its ranking, not the whole Net service.
        let first: URL
        try {
          first = new URL(endpoints[0]!)
        } catch {
          return
        }
        groups.set(id, { endpoints, holding: false })
        yield* register({
          id,
          host: first.hostname,
          port: Number(first.port || (first.protocol === "http:" ? 80 : 443)),
        })
      })

    const status = (id: string): Effect.Effect<Reachability> =>
      Effect.sync(() => entries.get(id)?.machine.state ?? { state: "idle" })

    const route = (id: string) => Effect.sync(() => entries.get(id)?.route)

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

    const ranking = (id: string): Effect.Effect<readonly RankedEndpoint[]> =>
      Effect.gen(function* () {
        const group = groups.get(id)
        if (!group) return []
        if (group.ranked) return group.ranked

        // Measured on first request, not at startup: a target nobody ends up
        // using should cost nothing (§3.3 按需激活).
        //
        // Every available route participates, not just the one currently in use.
        // The candidate set is (endpoint × route), and which combination is
        // quickest is settled by measurement rather than assumed — a proxy is
        // sometimes faster than a direct path that merely works. On a machine
        // with no proxy the set collapses to direct alone, which is exactly the
        // no-overhead case the design describes.
        const entry = entries.get(id)
        const routes = yield* Effect.promise(() => availableRoutes(entry?.target))
        const measured = yield* Effect.promise(() => NetRanking.rank(group.endpoints, routes))
        group.ranked = measured
        if (!group.holding) {
          group.holding = true
          yield* acquire(id)
        }
        return measured
      })

    return Service.of({ register, registerGroup, status, watch, route, ranking })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/** Re-exported so consumers reach the two route forms through one import. */
export const subprocessEnv = NetRoute.subprocessEnv
export const agent = NetRoute.agent
