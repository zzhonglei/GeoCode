export * as NetRanking from "./ranking"

import { NetProbe } from "./probe"
import { routeId, type RankedEndpoint, type Route, type Target } from "./types"

/* --- GeoCode: ordering a set of interchangeable endpoints (§3.3 端点排名). --- */

export interface Options extends NetProbe.Options {}

function targetOf(endpoint: string): Target | undefined {
  try {
    const url = new URL(endpoint)
    return {
      id: endpoint,
      host: url.hostname,
      port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
    }
  } catch {
    return undefined
  }
}

/**
 * Measure every endpoint over every available route and order them fastest first.
 *
 * **The route is one dimension of the MEASUREMENT**, not a setting applied
 * afterwards: different endpoints may be quickest by different paths, so each
 * one is timed over every path available and keeps the best. A consumer failing
 * over from one endpoint to the next therefore changes route along with it,
 * without ever having to think about routes.
 *
 * On a machine with no proxy the route list is just `direct`, so the candidate
 * set is identical to having no route dimension at all and costs nothing extra.
 * Where a proxy does exist, the path through it is measured alongside — and
 * **which is faster is decided by measurement, never assumed**.
 *
 * What is measured is the network path. Whether the service at the other end is
 * healthy — overloaded, refusing work — is outside what this can see, and is
 * left to the consumer's own failover on real requests (§6.3).
 */
export async function rank(
  endpoints: readonly string[],
  routes: readonly Route[],
  options: Options = {},
): Promise<RankedEndpoint[]> {
  const pairs = endpoints.flatMap((endpoint) => {
    const target = targetOf(endpoint)
    return target ? routes.map((route) => ({ endpoint, target, route })) : []
  })

  const measured = await Promise.all(
    pairs.map(async ({ endpoint, target, route }) => {
      const result =
        route.kind === "direct"
          ? await NetProbe.direct(target, options)
          : await NetProbe.viaProxy(target, route.url, options)
      return {
        endpoint,
        route,
        routeId: routeId(route),
        latencyMs: result.ok ? result.latencyMs : Number.POSITIVE_INFINITY,
      } satisfies RankedEndpoint
    }),
  )

  return order(measured)
}

/**
 * One entry per endpoint — its best route — reachable first.
 *
 * **The result is a list of ENDPOINTS, not of pairs.** The route is how the
 * measuring is done, not what the answer is made of: a consumer failing over
 * wants the next SERVICE to ask, and giving it the same host a second time by
 * another road is not a second chance. The road changes; the destination does
 * not. When a host is unhealthy at the service level — which no path
 * measurement can see, and which is the ordinary condition of a free public
 * pool — every route to it stalls identically, so a list of pairs spends the
 * consumer's whole budget twice over to learn one thing. Measured live against
 * the public Overpass pool: two such hosts, four entries, four minutes.
 *
 * Losing the runner-up route costs nothing that is not already covered: a route
 * that stops working is a change of route identity, and that invalidates the
 * ranking and re-measures (§3.3 失效由监视器驱动).
 *
 * Unreachable endpoints are PARKED AT THE BACK, not dropped. The probe is a
 * handshake with a short timeout, and one that is slow to greet, briefly
 * refusing, or behind a link that hiccuped during the measurement is not a dead
 * one. A measurement is evidence about the path, not a permit to use it, so
 * what it produces is an ORDER and never a shorter pool.
 *
 * What it is NOT is a prediction of which endpoint will serve the request.
 * Latency ordering separates "reachable" from "not", and past that it is close
 * to noise: measured live, the two fastest handshakes in the pool (732ms,
 * 735ms) were the two servers that then refused to answer at all, while the one
 * that served in 1.6s had ranked fifth. Only a real request settles that, which
 * is the consumer's business (§6.3).
 */
export function order(entries: readonly RankedEndpoint[]): RankedEndpoint[] {
  const best = new Map<string, RankedEndpoint>()
  for (const entry of entries) {
    const held = best.get(entry.endpoint)
    if (!held || entry.latencyMs < held.latencyMs) best.set(entry.endpoint, entry)
  }
  return [...best.values()].sort((a, b) => a.latencyMs - b.latencyMs)
}
