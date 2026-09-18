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

/* --- GeoCode: the only place network reachability is decided; capability modules read the conclusion and reproduce
 * none of it (docs/GEOKERNEL.md §3.3). --- */

export interface Change {
  readonly target: string
  readonly state: Reachability
}

/** One builder for the probe failures, since nothing flags an omitted `tried` or `skipped`: both are optional. */
export function failed(reason: string, tried: readonly string[]): NetMonitor.Verdict {
  return {
    ok: false,
    kind: NetClassifier.classify(reason),
    detail: reason,
    tried,
    skipped: NetDiscovery.skipped(),
  }
}

export interface Interface {
  readonly register: (target: Target) => Effect.Effect<void>
  readonly status: (id: string) => Effect.Effect<Reachability>
  /** Subscribing is what starts the monitoring, and the last unsubscribe stops it. */
  readonly watch: (id: string) => Stream.Stream<Reachability>
  readonly route: (id: string) => Effect.Effect<Route | undefined>
  /** The first candidate proxy that accepts a CONNECT to `target`, not merely one that is declared. */
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

    // Forked into the module's scope, not a subscriber's, so the loop outlives the watcher that started it.
    const scope = yield* Effect.scope

    const entries = new Map<string, Entry>()

    const publish = (entry: Entry) => PubSub.publish(pubsub, { target: entry.target.id, state: entry.machine.state })

    /** Returns the route beside the verdict so the caller never resolves twice — resolving is real handshakes. */
    const probeOnce = (entry: Entry) =>
      Effect.promise(async (): Promise<{ verdict: NetMonitor.Verdict; route?: Route }> => {
        // First because it costs no traffic at all, and it is the unambiguous signal that skips hysteresis.
        if (!NetClassifier.hasNetworkInterface()) {
          // Not `failed`: an empty `tried` would read as "found nowhere to go", and being offline is no proxy problem.
          return { verdict: { ok: false, kind: "offline", detail: "no network interface is up" } }
        }

        // A held route is re-verified as itself, so a lost connection and a closed proxy fail on the same path.
        const held = entry.route
        if (!NetMonitor.shouldRediscover(entry.machine) && held) {
          const result =
            held.kind === "direct"
              ? await NetProbe.direct(entry.target)
              : await NetProbe.viaProxy(entry.target, held.url)
          if (result.ok) return { verdict: { ok: true, routeId: routeId(held) }, route: held }
          return { verdict: failed(result.reason, [routeId(held)]) }
        }

        const resolution = await NetResolver.resolve(entry.target)
        if (resolution.ok) return { verdict: { ok: true, routeId: resolution.routeId }, route: resolution.route }
        return { verdict: failed(resolution.reason, resolution.tried) }
      })

    const applyVerdict = (entry: Entry, verdict: NetMonitor.Verdict) =>
      Effect.gen(function* () {
        const before = entry.machine.state
        entry.machine = NetMonitor.step(entry.machine, verdict)
        if (!verdict.ok) entry.route = entry.machine.state.state === "reachable" ? entry.route : undefined
        // Publishing only on real change keeps a steady network silent.
        if (!isDeepStrictEqual(before, entry.machine.state)) yield* publish(entry)
      })

    const runLoop = (entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          // An uncaught defect would take the loop's fiber with it and end monitoring for this target for good.
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
        // A defect in discovery means no proxy is known, not a reason to take the caller down.
        Effect.catchDefect(() => Effect.succeed(undefined)),
      )

    const watch = (id: string): Stream.Stream<Reachability> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading: the reverse loses any change landing between the two calls.
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

export const subprocessEnv = NetRoute.subprocessEnv
export const agent = NetRoute.agent
