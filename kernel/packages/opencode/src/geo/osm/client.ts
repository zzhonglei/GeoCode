export * as OsmClient from "./client"

import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { GeoNet } from "../net"
import type { NetTypes } from "../net/types"
import { OsmHttp } from "./http"

/* --- GeoCode: the reliability layer over three public OSM services (docs/GEOKERNEL.md §6.3).
 *
 * Net is asked one question — has this machine got a proxy — and which server to ask, in what order and when to
 * give up on one are settled here from what the services are, never from a measurement. --- */

/** Tier one: the reference deployment, plus its two named backends. */
const OFFICIAL_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  // The main name has been observed to round-robin over these two, so a sick backend behind it can be stepped past
  // by asking for the other by name.
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
] as const

/**
 * Tier two, and full-planet instances only: a region-limited one answers a query about anywhere else with success
 * and no data, which nothing in the response distinguishes from an area that really is empty (§6.3).
 */
const MIRROR_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  // Checked full-planet by asking it for an object in China and comparing with the official answer.
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
] as const

export const OVERPASS_ENDPOINTS = [...OFFICIAL_ENDPOINTS, ...MIRROR_ENDPOINTS] as const

/** Only Net's proxy question is asked about this host; the answer is then worn for every endpoint and service. */
const AUTHORITY = { id: "osm", host: "overpass-api.de", port: 443 }

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
const OSM_API_BASE = "https://api.openstreetmap.org/api/0.6"

/**
 * The public services throttle a caller who goes faster. A clock each, so a
 * Nominatim call does not wait behind an Overpass one.
 */
const MIN_INTERVAL_MS = { overpass: 1_100, nominatim: 1_100, api: 1_000 }

/**
 * One retry over the pool and no more: eight endpoints are themselves the redundancy, so a further pass repeats a
 * verdict the first one reached, at the price of the full timeout of every endpoint that connects and then says
 * nothing (§6.3 轮间退避).
 */
const MAX_ROUNDS = 2
const RETRY_BACKOFF_MS = 3_000

export interface OverpassResult {
  readonly json: unknown
  readonly endpoint: string
  /**
   * The server's own words for a result it reports incomplete, carried in a normal status code and a well-formed
   * body — so a status-and-parse check alone reads this as a clean success (§6.3 第四种失败).
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
  readonly overpass: (ql: string, options?: Options) => Effect.Effect<OverpassResult, OsmError>
  readonly nominatim: (query: string, options?: Options & { limit?: number }) => Effect.Effect<unknown, OsmError>
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
    // Undefined rather than zero: there is nothing to space the first request of a session away from.
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
     * One decision for all three services, because needing a proxy is a fact about the machine rather than about
     * which public host is asked. Serialized because a search asks two of the services at once (index.ts), and the
     * two would otherwise open a discovery sweep each to learn the same thing.
     */
    let known: NetTypes.Route | undefined
    const asking = Semaphore.makeUnsafe(1)
    const currentRoute = asking.withPermits(1)(
      Effect.gen(function* () {
        if (known) return known
        const found = yield* net.proxy(AUTHORITY)
        known = found ? { kind: "proxy", url: found } : { kind: "direct" }
        return known
      }),
    )
    const forgetRoute = Effect.sync(() => {
      known = undefined
    })

    const overpass = (ql: string, options: Options = {}): Effect.Effect<OverpassResult, OsmError> =>
      Effect.gen(function* () {
        const timeoutMs = options.timeoutMs ?? 120_000
        const route = yield* currentRoute
        const attempts: string[] = []
        const routeId = route.kind === "direct" ? "direct" : "proxy"

        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (round > 0) yield* Effect.sleep(RETRY_BACKOFF_MS)
          for (let step = 0; step < OVERPASS_ENDPOINTS.length; step++) {
            const index = (sticky + step) % OVERPASS_ENDPOINTS.length
            const endpoint = OVERPASS_ENDPOINTS[index]!
            if (options.abort?.aborted) {
              return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
            }

            const outcome = yield* spaced(
              "overpass",
              http.request({
                url: endpoint,
                method: "POST",
                body: "data=" + encodeURIComponent(ql),
                route,
                timeoutMs,
                abort: options.abort,
              }),
            ).pipe(Effect.result)

            if (outcome._tag === "Failure") {
              const error = outcome.failure
              if (error instanceof DOMException)
                return yield* Effect.fail(new OsmError("cancelled", "exhausted", attempts))
              // Another endpoint would produce the same enormous answer; only asking for less can fix it.
              if (error.oversized) return yield* Effect.fail(new OsmError(error.message, "oversized", attempts))
              attempts.push(`${host(endpoint)} via ${routeId}: ${error.message}`)
              continue
            }

            const response = outcome.success
            if (response.status < 200 || response.status >= 300) {
              attempts.push(`${host(endpoint)} via ${routeId}: HTTP ${response.status}`)
              continue
            }

            let json: unknown
            try {
              json = JSON.parse(response.body)
            } catch {
              // A busy instance answers 200 with an HTML error page, so parseability is a failover test of its own.
              attempts.push(`${host(endpoint)} via ${routeId}: body was not JSON`)
              continue
            }

            sticky = index
            const remark = (json as { remark?: unknown })?.remark
            return { json, endpoint, remark: typeof remark === "string" ? remark : undefined }
          }
        }

        // Everything failed, which is the one moment worth doubting the route rather than the servers: a proxy may
        // have started, stopped or moved since Net was asked.
        yield* forgetRoute
        return yield* Effect.fail(
          new OsmError(
            `all ${OVERPASS_ENDPOINTS.length} Overpass endpoints failed across ${MAX_ROUNDS} rounds`,
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
          const route = yield* currentRoute
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
        yield* forgetRoute
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
          const route = yield* currentRoute
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
          // Settled answers about the object rather than transport trouble, so another attempt only repeats them.
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
        yield* forgetRoute
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
