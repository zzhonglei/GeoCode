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
 * The division of labour with Net is one sentence: **Net says how to get out of
 * the building, this module decides who to ask.** Net answers "is there a proxy
 * on this machine" — a fact about the machine, cheap and local. Which server to
 * ask, in what order, and when to give up on one are questions about the OSM
 * ecosystem, and they are answered here, without measuring anything: a
 * handshake tells you about the road, and what decides an answer is whether the
 * server is willing to work. Only a real request reveals that. --- */

/* --- The endpoint order is FIXED and TIERED, not measured (§6.3).
 *
 * The official instance first, third-party mirrors only after it has actually
 * failed a request. The tiers rest on what these services ARE, not on how they
 * performed somewhere:
 *
 * - the official instance is the reference deployment — the one whose data
 *   currency and behaviour the project itself stands behind, and the one whose
 *   quirks the rest of the ecosystem is written against;
 * - a mirror is somebody's donated hardware. It may lag, it may be rebuilt from
 *   a stale planet file, it may quietly serve a region-limited extract. When it
 *   is right it is indistinguishable from the official instance, so preferring
 *   it buys nothing; when it is wrong the caller cannot tell.
 *
 * This deliberately replaces ordering by measured latency. Measuring means
 * probing every mirror on a fresh process before asking anyone anything — a
 * cost paid by every user, and a burst of handshakes aimed at donated servers
 * for the privilege of not using them. It also ranks on the wrong evidence: a
 * handshake measures the ROAD, and what decides an answer is whether the server
 * is willing to work, which only a real request reveals (§6.3). Mirrors exist
 * to be a fallback; they are used like one. --- */

/** Tier one: the reference deployment, plus its two named backends. */
const OFFICIAL_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  // The main name has been observed to round-robin over these two, so a sick
  // backend behind it can be stepped past by asking for the other by name.
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
] as const

/**
 * Tier two: third-party mirrors, reached only when tier one fails.
 *
 * FULL-PLANET INSTANCES ONLY. A region-limited mirror answers successfully with
 * data that silently excludes everything outside its region, which is worse
 * than an error by a wide margin — the caller has no way to notice. The order
 * within this tier carries no claim; it is only reached when the reference
 * deployment is unusable, and one donated server is not knowably better than
 * the next.
 */
const MIRROR_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  // Checked full-planet by asking it for an object in China and comparing with
  // the official answer — the only check that means anything, since a
  // region-limited instance answers a foreign query with success and no data.
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
] as const

/**
 * A built-in constant rather than configuration: running a private instance is
 * advanced usage, and it does not justify a configuration surface every user
 * would have to understand (§6.3, §12).
 */
export const OVERPASS_ENDPOINTS = [...OFFICIAL_ENDPOINTS, ...MIRROR_ENDPOINTS] as const

/** The host Net is asked about, and the one every tunnel is opened towards. */
const AUTHORITY = { id: "osm", host: "overpass-api.de", port: 443 }

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

/**
 * Passes over the endpoint list, and the wait between them.
 *
 * **The pool is the redundancy; passes are redundancy of redundancy.** Eight
 * endpoints already give one call eight independent chances, and a pass only
 * ends early — at the first endpoint that answers. So reaching a second pass
 * means the entire pool just failed, and asking the same eight servers again is
 * worth something only if the trouble is measured in seconds. Public instance
 * sickness is measured in minutes to hours.
 *
 * One retry, because the throttle already spreads a pass over about ten seconds
 * and a momentary 503 can clear in that time. Not two: a third pass would only
 * postpone the same answer, and it postpones it expensively — an endpoint that
 * accepts the connection and then says nothing costs the full client budget,
 * and a third pass over two such endpoints is another five minutes of silence
 * before the caller is told what was already known.
 */
const MAX_ROUNDS = 2
const RETRY_BACKOFF_MS = 3_000

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
     * How this machine gets out — asked of Net once, then reused.
     *
     * One decision for all three OSM services, because it is a fact about the
     * MACHINE, not about which server is being asked: these are ordinary public
     * hosts, and a network that needs a proxy to reach one needs it to reach all
     * of them. Where no proxy exists this settles to `direct` after a handful of
     * refused loopback connections and never costs anything again.
     *
     * Re-asked only after a whole call has failed everywhere, which is the one
     * moment the answer might have changed — a proxy started, stopped, or moved
     * while the session was running.
     *
     * Serialized, because the two search engines are asked in PARALLEL: without
     * this, the first search of a session would send two discovery sweeps at the
     * same moment to learn the same thing. The second caller waits, finds the
     * answer already there, and returns.
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
        // ONE route decision for the whole pool, taken against the official
        // instance. These are all ordinary public hosts on the open internet:
        // whether this machine needs a proxy to reach OSM is a fact about the
        // machine, not about which mirror is being asked. Net answers it once —
        // direct if direct works, the proxy it found if not.
        const route = yield* currentRoute
        const attempts: string[] = []
        const routeId = route.kind === "direct" ? "direct" : "proxy"

        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (round > 0) yield* Effect.sleep(RETRY_BACKOFF_MS)
          for (let step = 0; step < OVERPASS_ENDPOINTS.length; step++) {
            // From wherever the last success was, so a run that has already
            // fallen through to a mirror does not re-pay the official
            // instance timeout on every subsequent call (§6.3 粘性端点).
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
              // A body that outgrew the ceiling is the caller's problem to
              // solve by asking for less; another endpoint would do the same.
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
              // The third failure shape, and the one a status check misses
              // entirely: a busy instance answers 200 with an HTML error page.
              // Parseability is therefore a failover criterion in its own right.
              attempts.push(`${host(endpoint)} via ${routeId}: body was not JSON`)
              continue
            }

            sticky = index
            const remark = (json as { remark?: unknown })?.remark
            return { json, endpoint, remark: typeof remark === "string" ? remark : undefined }
          }
        }

        // Every endpoint just failed, which is the one moment worth doubting the
        // route rather than the servers: a proxy may have started, stopped or
        // moved since it was last asked about. Any other time, re-asking would
        // be loopback connections spent to be told the same thing.
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
