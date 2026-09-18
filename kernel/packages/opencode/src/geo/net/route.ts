export * as NetRoute from "./route"

import http from "node:http"
import https from "node:https"
import net from "node:net"
import type stream from "node:stream"
import tls from "node:tls"
import { NetTunnel } from "./tunnel"
import type { Route } from "./types"

/* --- GeoCode: the two shapes a resolved path takes, subprocess environment and in-process agent
 * (docs/GEOKERNEL.md §3.3). --- */

/** Loopback stays off the proxy, or a subprocess's local callback never arrives. */
const NO_PROXY_LOCAL = "localhost,127.0.0.1,::1"

/** Both cases: the runtimes we launch disagree about which one they read. */
export const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const

/** Direct blanks inherited proxy variables, or the subprocess keeps a proxy the resolver decided against. */
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
    // The signature allows a synchronous return; ours never is — opening a tunnel is a round trip.
    if (!callback) return null
    const host = options.host ?? ""
    const port = Number(options.port ?? 443)
    NetTunnel.open(this.proxyUrl, `${host}:${port}`, this.timeoutMs)
      .then((result) => {
        if (!result.ok) {
          callback(new Error(`proxy tunnel failed at ${result.stage}: ${result.reason}`), undefined as never)
          return
        }
        // Verification stays on, as in the probe: a route that only works with checks off is not one we adopt.
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

/** A Node agent rather than a fetch dispatcher, so consumers of this form issue their requests through `node:https`. */
export function agent(route: Route, timeoutMs = 30_000): https.Agent | undefined {
  if (route.kind === "direct") return undefined
  return new TunnelAgent(route.url, timeoutMs)
}
