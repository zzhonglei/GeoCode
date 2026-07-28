export * as OsmClient from "./client"

import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { GeoNet } from "../net"
import type { NetTypes } from "../net/types"
import { OsmHttp } from "./http"

/* --- GeoCode: the reliability layer (docs/GEOKERNEL.md §6.3).
 *
 * Public OSM services are unreliable as a matter of course, not as an
 * exception: a single backend can be sick for hours, reachability differs
 * enormously between users' networks, and rapid requests get throttled. This
 * module is where that is absorbed, and it is the module's core asset.
 *
 * The division of labour with Net is exact. Net measures NETWORK PATHS and
 * orders (endpoint, route) pairs; it cannot see whether the service behind a
 * fast path is refusing work. That is what the failover here is for — a first
 * real request is the only thing that can tell. --- */

/**
 * The endpoint pool.
 *
 * FULL-PLANET INSTANCES ONLY. A region-limited instance answers successfully
 * with data that silently excludes everything outside its region, which is
 * worse than an error by a wide margin — the caller has no way to notice.
 *
 * A built-in constant rather than configuration: running a private instance is
 * advanced usage, and it does not justify a configuration surface every user
 * would have to understand (§6.3, §12).
 */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
] as const

/** The ranking group id, and the anchor whose route changes invalidate it. */
export const OVERPASS_GROUP = "osm-overpass"

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
const OSM_API_BASE = "https://api.openstreetmap.org/api/0.6"

/**
 * Minimum spacing between requests to one service.
 *
 * These are shared public services with published etiquette; going faster gets
 * everyone throttled. Each service keeps its own clock — a Nominatim call must
 * not have to wait behind an Overpass one.
 */
const MIN_INTERVAL_MS = { overpass: 1_100, nominatim: 1_100, api: 1_000 }

/** Passes over the whole endpoint list, and how long to wait between them. */
const MAX_ROUNDS = 3
const ROUND_BACKOFF_MS = [2_000, 4_000, 8_000]

export interface OverpassResult {
  readonly json: unknown
  readonly endpoint: string
  /**
   * The soft failure (§6.3 第四种失败).
   *
   * A normal status code and a well-formed body, carrying a note that says the
   * result is incomplete — typically a server-side query timeout. It does NOT
   * fail the endpoint over, because the data that did arrive is usable, but the
   * call must be recorded as incomplete and say so. Checking only the status
   * code and the parse would call this a complete success, which is the most
   * dangerous of the four failure shapes.
   */
  readonly remark?: string
}

export class OsmError extends Error {
  constructor(
    message: string,
    readonly kind: "exhausted" | "not-found" | "gone" | "oversized",
    readonly attempts: readonly string[] = [],
  ) {
    super(message)
    this.name = "OsmError"
  }
}

export interface Options {
  readonly abort?: AbortSignal
  readonly timeoutMs?: number
}

export interface Interface {
  /** Run an Overpass QL query, failing over across the ranked endpoints. */
  readonly overpass: (ql: string, options?: Options) => Effect.Effect<OverpassResult, OsmError>
  /** Ask the geocoding service for fuzzy name candidates. */
  readonly nominatim: (query: string, options?: Options & { limit?: number }) => Effect.Effect<unknown, OsmError>
  /** Fetch one object with its members from the canonical API. */
  readonly osmApi: (
    type: "relation" | "way" | "node",
    id: number,
    options?: Options,
  ) => Effect.Effect<unknown, OsmError>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/OsmClient") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const net = yield* GeoNet.Service
    const http = yield* OsmHttp.Service

    /** Where the last success was, so a healthy endpoint keeps being used (§6.3 粘性端点). */
    let sticky = 0
    // Undefined means "not yet asked", which is not the same as "asked at time
    // zero": there is nothing to space the first request away from.
    const lastAt: Partial<Record<keyof typeof MIN_INTERVAL_MS, number>> = {}
    /** One request at a time per service, so the spacing below cannot be raced past. */
    const turns = {
      overpass: Semaphore.makeUnsafe(1),
      nominatim: Semaphore.makeUnsafe(1),
      api: Semaphore.makeUnsafe(1),
    }

    const spaced = <A, E>(service: keyof typeof MIN_INTERVAL_MS, effect: Effect.Effect<A, E>) =>
      turns[service].withPermits(1)(
        Effect.gen(function* () {
          const previous = lastAt[service]
          if (previous !== undefined) {
            const wait = previous + MIN_INTERVAL_MS[service] - (yield* Clock.currentTimeMillis)
            if (wait > 0) yield* Effect.sleep(wait)
          }
          lastAt[service] = yield* Clock.currentTimeMillis
          return yield* effect
        }),
      )

    /**
     * The ordered (endpoint, route) pairs, from Net.
     *
     * Asked for on every call rather than cached here: Net invalidates its own
     * ranking when the route identity changes and re-measures on the next
     * request, so asking is either free or exactly what we want (§6.3 失效由
     * Net 驱动). Nothing polls, and no stale ranking survives a network change.
     */
    const ranked = Effect.gen(function* () {
      yield* net.registerGroup(OVERPASS_GROUP, [...OVERPASS_ENDPOINTS])
      const ranking = yield* net.ranking(OVERPASS_GROUP)
      if (ranking.length > 0) return ranking
      // Nothing measured — every endpoint unreachable, or the measurement
      // itself failed. Try them all direct rather than refusing outright: a
      // measurement is evidence about the path, not a permit.
      return OVERPASS_ENDPOINTS.map((endpoint) => ({
        endpoint,
        route: { kind: "direct" } as NetTypes.Route,
        routeId: "direct",
        latencyMs: Number.POSITIVE_INFINITY,
      }))
    })

    const overpass = (ql: string, options: Options = {}): Effect.Effect<OverpassResult, OsmError> =>
      Effect.gen(function* () {
        const timeoutMs = options.timeoutMs ?? 120_000
        const order = yield* ranked
        const attempts: string[] = []

        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (round > 0) yield* Effect.sleep(ROUND_BACKOFF_MS[round - 1]!)
          for (let step = 0; step < order.length; step++) {
            const index = (sticky + step) % order.length
            const candidate = order[index]!
            if (options.abort?.aborted) {
              return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
            }

            const outcome = yield* spaced(
              "overpass",
              http.request({
                url: candidate.endpoint,
                method: "POST",
                body: "data=" + encodeURIComponent(ql),
                route: candidate.route,
                timeoutMs,
                abort: options.abort,
              }),
            ).pipe(Effect.result)

            if (outcome._tag === "Failure") {
              const error = outcome.failure
              if (error instanceof DOMException)
                return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
              // A body that outgrew the ceiling is the caller's problem to
              // solve by asking for less; another endpoint would do the same.
              if (error.oversized) return yield* Effect.fail(new OsmError(error.message, "oversized", attempts))
              attempts.push(`${host(candidate.endpoint)} via ${candidate.routeId}: ${error.message}`)
              continue
            }

            const response = outcome.success
            if (response.status < 200 || response.status >= 300) {
              attempts.push(`${host(candidate.endpoint)} via ${candidate.routeId}: HTTP ${response.status}`)
              continue
            }

            let json: unknown
            try {
              json = JSON.parse(response.body)
            } catch {
              // The third failure shape, and the one a status check misses
              // entirely: a busy instance answers 200 with an HTML error page.
              // Parseability is therefore a failover criterion in its own right.
              attempts.push(`${host(candidate.endpoint)} via ${candidate.routeId}: body was not JSON`)
              continue
            }

            sticky = index
            const remark = (json as { remark?: unknown })?.remark
            return { json, endpoint: candidate.endpoint, remark: typeof remark === "string" ? remark : undefined }
          }
        }

        return yield* Effect.fail(
          new OsmError(
            `all ${order.length} Overpass endpoints failed across ${MAX_ROUNDS} rounds`,
            "exhausted",
            attempts,
          ),
        )
      })

    const nominatim = (query: string, options: Options & { limit?: number } = {}) =>
      Effect.gen(function* () {
        const params = new URLSearchParams({
          q: query,
          format: "json",
          addressdetails: "1",
          extratags: "1",
          limit: String(options.limit ?? 10),
        })
        const attempts: string[] = []
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) yield* Effect.sleep(2_000)
          if (options.abort?.aborted) return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
          const route = (yield* net.route(OVERPASS_GROUP)) ?? { kind: "direct" }
          const outcome = yield* spaced(
            "nominatim",
            http.request({
              url: `${NOMINATIM_URL}?${params}`,
              route,
              timeoutMs: options.timeoutMs ?? 30_000,
              abort: options.abort,
            }),
          ).pipe(Effect.result)
          if (outcome._tag === "Failure") {
            if (outcome.failure instanceof DOMException) {
              return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
            }
            attempts.push(outcome.failure.message)
            continue
          }
          if (outcome.success.status < 200 || outcome.success.status >= 300) {
            attempts.push(`HTTP ${outcome.success.status}`)
            continue
          }
          try {
            return JSON.parse(outcome.success.body) as unknown
          } catch {
            attempts.push("body was not JSON")
          }
        }
        return yield* Effect.fail(new OsmError("the geocoding service did not answer", "exhausted", attempts))
      })

    const osmApi = (type: "relation" | "way" | "node", id: number, options: Options = {}) =>
      Effect.gen(function* () {
        // Nodes carry no members, so `/full` does not exist for them.
        const path = type === "node" ? `node/${id}.json` : `${type}/${id}/full.json`
        const attempts: string[] = []
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) yield* Effect.sleep(1_000 * 2 ** (attempt - 1))
          if (options.abort?.aborted) return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
          const route = (yield* net.route(OVERPASS_GROUP)) ?? { kind: "direct" }
          const outcome = yield* spaced(
            "api",
            http.request({
              url: `${OSM_API_BASE}/${path}`,
              route,
              timeoutMs: options.timeoutMs ?? 180_000,
              abort: options.abort,
            }),
          ).pipe(Effect.result)
          if (outcome._tag === "Failure") {
            if (outcome.failure instanceof DOMException) {
              return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
            }
            attempts.push(outcome.failure.message)
            continue
          }
          const response = outcome.success
          // Both are settled answers about the object, not transport trouble —
          // retrying would only repeat them.
          if (response.status === 404) {
            return yield* Effect.fail(new OsmError(`${type}/${id} does not exist`, "not-found", attempts))
          }
          if (response.status === 410) {
            return yield* Effect.fail(new OsmError(`${type}/${id} has been deleted`, "gone", attempts))
          }
          if (response.status < 200 || response.status >= 300) {
            attempts.push(`HTTP ${response.status}`)
            continue
          }
          try {
            return JSON.parse(response.body) as unknown
          } catch {
            attempts.push("body was not JSON")
          }
        }
        return yield* Effect.fail(new OsmError(`the OSM API did not answer for ${type}/${id}`, "exhausted", attempts))
      })

    return Service.of({ overpass, nominatim, osmApi })
  }),
)

function host(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return endpoint
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [GeoNet.node, OsmHttp.node] })
