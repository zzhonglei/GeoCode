export * as NetRoute from "./route"

import http from "node:http"
import https from "node:https"
import net from "node:net"
import type stream from "node:stream"
import tls from "node:tls"
import { NetTunnel } from "./tunnel"
import type { Route } from "./types"

/* --- GeoCode: the two shapes a resolved path takes (docs/GEOKERNEL.md §3.3
 * 路由形态).
 *
 * Neither substitutes for the other, and the reason is not stylistic: code
 * running in a subprocess does not read our objects, and code running in this
 * process does not read environment variables. The difference is in where the
 * access happens.
 *
 * When it is applied differs just as fundamentally. A subprocess's environment
 * is fixed the moment it starts, so one route serves everything it will ever
 * do. In-process access picks a route PER REQUEST — endpoint ranking produces
 * (endpoint, route) pairs, so different endpoints may travel differently, and a
 * failover that switches endpoint switches route with it. Installing one global
 * route would throw the ranking away. --- */

/** Keeps loopback traffic off the proxy: local callbacks and local services. */
const NO_PROXY_LOCAL = "localhost,127.0.0.1,::1"

/**
 * Every spelling a subprocess might read.
 *
 * Both cases, because the runtimes we launch disagree: some libraries read the
 * lowercase form, others the uppercase, and a single-case injection quietly
 * routes only part of a program's traffic.
 */
export const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const

/**
 * Environment for a subprocess that will use this route.
 *
 * The direct case is not empty. If the host process inherited proxy variables
 * and the resolved route is direct, they must be **blanked**, not merely left
 * un-set: an inherited value would otherwise keep routing the subprocess
 * through a proxy the resolver has just decided against, making "direct" untrue
 * (§3.3, 直连需显式清除).
 */
export function subprocessEnv(route: Route, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (route.kind === "proxy") {
    const env: Record<string, string> = {}
    for (const key of PROXY_KEYS) env[key] = route.url
    env.NO_PROXY = inherited.NO_PROXY ?? NO_PROXY_LOCAL
    env.no_proxy = inherited.no_proxy ?? NO_PROXY_LOCAL
    return env
  }
  const env: Record<string, string> = {}
  for (const key of PROXY_KEYS) if (inherited[key]) env[key] = ""
  return env
}

/**
 * An agent that carries requests through a proxy tunnel.
 *
 * Built on the same CONNECT handshake the probe uses, so what was verified is
 * what is used.
 */
class TunnelAgent extends https.Agent {
  constructor(
    private readonly proxyUrl: string,
    private readonly timeoutMs: number,
  ) {
    super({ keepAlive: true })
  }

  override createConnection(
    options: http.ClientRequestArgs & { servername?: string },
    callback?: (err: Error | null, stream: stream.Duplex) => void,
  ): stream.Duplex | null | undefined {
    // The signature allows a synchronous return; ours is always asynchronous,
    // because opening a tunnel is a network round trip.
    if (!callback) return null
    const host = options.host ?? ""
    const port = Number(options.port ?? 443)
    NetTunnel.open(this.proxyUrl, `${host}:${port}`, this.timeoutMs)
      .then((result) => {
        if (!result.ok) {
          callback(new Error(`proxy tunnel failed at ${result.stage}: ${result.reason}`), undefined as never)
          return
        }
        // Verification stays on here exactly as it does in the probe: a route
        // that only works with checks disabled is not a route we would adopt.
        const name = options.servername ?? host
        const secure = tls.connect({ socket: result.socket, servername: net.isIP(name) === 0 ? name : undefined })
        secure.once("secureConnect", () => callback(null, secure))
        secure.once("error", (err: unknown) =>
          callback(err instanceof Error ? err : new Error(String(err)), undefined as never),
        )
      })
      .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), undefined as never))
    return undefined
  }
}

/**
 * The in-process form: an agent to hand to a request, per request.
 *
 * `undefined` for a direct route — the caller simply passes nothing, which is
 * both the default behaviour and the honest representation of "no proxy".
 *
 * A Node agent rather than a fetch dispatcher, deliberately. The kernel runs on
 * plain Node APIs so that a sidecar and a command line behave identically
 * (§10.3), and reaching a dispatcher would mean taking on a dependency that is
 * not resolvable there today. The consequence is real and belongs in the open:
 * consumers of this form issue requests through `node:https`.
 */
export function agent(route: Route, timeoutMs = 30_000): https.Agent | undefined {
  if (route.kind === "direct") return undefined
  return new TunnelAgent(route.url, timeoutMs)
}
