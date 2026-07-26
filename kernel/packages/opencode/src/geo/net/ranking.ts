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
 * **The route is one dimension of the candidate set**, not a setting applied
 * afterwards. The set is (endpoint × route), so the result is a sequence of
 * PAIRS: different endpoints may be quickest by different paths, and a consumer
 * failing over from one to the next changes route along with it.
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
      if (!result.ok) return undefined
      return { endpoint, route, routeId: routeId(route), latencyMs: result.latencyMs } satisfies RankedEndpoint
    }),
  )

  // Unreachable pairs are dropped rather than parked at the back. A consumer
  // that runs out of ranked pairs already has its own failover and backoff to
  // fall back on; carrying known-dead pairs would only make it pay their
  // timeouts a second time.
  return measured.filter((entry): entry is RankedEndpoint => entry !== undefined).sort((a, b) => a.latencyMs - b.latencyMs)
}
