export * as NetResolver from "./resolver"

import { NetDiscovery } from "./discovery"
import { NetProbe } from "./probe"
import { routeId, type Route, type RouteId, type Target } from "./types"

/* --- GeoCode: resolving a path to one target (docs/GEOKERNEL.md §3.3
 * 路径解析:直连优先,代理回退). --- */

export interface Options extends NetDiscovery.Options {
  readonly probeTimeoutMs?: number
}

export type Resolution =
  | { readonly ok: true; readonly route: Route; readonly routeId: RouteId; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: string; readonly tried: readonly RouteId[] }

export async function resolve(target: Target, options: Options = {}): Promise<Resolution> {
  const tried: RouteId[] = ["direct"]

  const direct = await NetProbe.direct(target, { timeoutMs: options.probeTimeoutMs, tls: options.tls })
  if (direct.ok) {
    return { ok: true, route: { kind: "direct" }, routeId: "direct", latencyMs: direct.latencyMs }
  }

  const candidates = await NetDiscovery.candidates(target, options)
  for (const url of candidates) {
    const route: Route = { kind: "proxy", url }
    const id = routeId(route)
    tried.push(id)
    const viaProxy = await NetProbe.viaProxy(target, url, {
      timeoutMs: options.probeTimeoutMs,
      tls: options.tls,
    })
    if (viaProxy.ok) return { ok: true, route, routeId: id, latencyMs: viaProxy.latencyMs }
  }

  return {
    ok: false,
    // The direct failure, whatever the proxies then did: failure kinds drive behaviour, never wording (§3.3).
    reason: direct.reason,
    tried,
  }
}
