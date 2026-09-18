export * as NetProbe from "./probe"

import net from "node:net"
import tls from "node:tls"
import { NetTunnel } from "./tunnel"
import type { Target } from "./types"

/* --- GeoCode: the probes behind every reachability verdict, in-process sockets and never a subprocess, which keeps
 * Net independent of Runtime (docs/GEOKERNEL.md §3.3). --- */

/** A hanging handshake holds the monitor's round this long before its interval sleep starts. */
const DEFAULT_TIMEOUT_MS = 3_000

/** Loopback only: this bounds the one expensive case, a port that is open but answers nothing. */
export const LOOPBACK_TIMEOUT_MS = 1_000

export interface Options {
  readonly timeoutMs?: number
  /** Tests only, against a locally generated certificate. */
  readonly tls?: tls.ConnectionOptions
}

export type Stage = "connect" | "tunnel" | "handshake"

export type Result =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly stage: Stage; readonly reason: string }

/** The runtime throws on an IP address as the TLS server name, so a literal-address target is probed without one. */
function serverName(host: string): string | undefined {
  return net.isIP(host) === 0 ? host : undefined
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/** Only a completed handshake proves we reached the genuine endpoint, so verification stays on. */
export function direct(target: Target, options: Options = {}): Promise<Result> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  return new Promise<Result>((resolve) => {
    let settled = false
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: serverName(target.host),
      ...options.tls,
    })
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () =>
      finish({ ok: false, stage: "handshake", reason: `timed out after ${timeoutMs}ms` }),
    )
    socket.once("secureConnect", () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
    socket.once("error", (err: unknown) => finish({ ok: false, stage: "handshake", reason: reasonOf(err) }))
  })
}

export async function viaProxy(target: Target, proxyUrl: string, options: Options = {}): Promise<Result> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  const tunnel = await NetTunnel.open(proxyUrl, `${target.host}:${target.port}`, timeoutMs)
  if (!tunnel.ok) return { ok: false, stage: tunnel.stage, reason: tunnel.reason }

  // Stage 3 is not skippable: some proxies answer the tunnel request without ever checking upstream.
  return new Promise<Result>((resolve) => {
    let settled = false
    const secure = tls.connect({ socket: tunnel.socket, servername: serverName(target.host), ...options.tls })
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      secure.destroy()
      tunnel.socket.destroy()
      resolve(result)
    }
    secure.setTimeout(timeoutMs, () =>
      finish({ ok: false, stage: "handshake", reason: `timed out after ${timeoutMs}ms` }),
    )
    secure.once("secureConnect", () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
    secure.once("error", (err: unknown) => finish({ ok: false, stage: "handshake", reason: reasonOf(err) }))
  })
}

/** A cheap liveness check, never evidence of a proxy on its own. */
export function listening(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}
