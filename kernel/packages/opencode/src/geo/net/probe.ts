export * as NetProbe from "./probe"

import net from "node:net"
import tls from "node:tls"
import { NetTunnel } from "./tunnel"
import type { Target } from "./types"

/* --- GeoCode: the probes behind every reachability verdict (§3.3 探针规格).
 *
 * All of this happens inside our own process — no subprocess is started. That
 * is not incidental: it is what lets Net depend on nothing but the host kernel,
 * and it follows directly from the decision not to read the operating system's
 * proxy settings (§12), which was the only thing that would have needed one. --- */

/** Local proxy ports answer or refuse in about a millisecond; this bounds the remote case. */
const DEFAULT_TIMEOUT_MS = 5_000

export interface Options {
  readonly timeoutMs?: number
  /**
   * Extra TLS settings.
   *
   * Exists so the probe can be exercised against a locally generated
   * certificate. Nothing in the kernel passes it — production always uses the
   * default trust store, because a probe that skipped verification would prove
   * only that SOMETHING answered.
   */
  readonly tls?: tls.ConnectionOptions
}

/** Which of the three stages a proxy probe got to before failing. */
export type Stage = "connect" | "tunnel" | "handshake"

export type Result =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly stage: Stage; readonly reason: string }

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * Complete a real TLS handshake with the target.
 *
 * A handshake, not a connection: only finishing one proves we arrived at the
 * genuine endpoint. A reset partway, a name that will not resolve, a silent
 * timeout — each fails here, which is the point.
 *
 * Certificate verification stays on. Turning it off would make the probe agree
 * with anything that answers on the port, which is worse than no probe at all.
 */
export function direct(target: Target, options: Options = {}): Promise<Result> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  return new Promise<Result>((resolve) => {
    let settled = false
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      ...options.tls,
    })
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish({ ok: false, stage: "handshake", reason: `timed out after ${timeoutMs}ms` }))
    socket.once("secureConnect", () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
    socket.once("error", (err: unknown) => finish({ ok: false, stage: "handshake", reason: reasonOf(err) }))
  })
}

/**
 * Ask a candidate whether it is a proxy that can reach the target — in three
 * stages, because each answers a different question.
 *
 * 1. Open a connection. Proves only that something is listening; it could be
 *    any local service at all.
 * 2. Ask for a tunnel in the proxy's own protocol. **Only a proxy answers this
 *    correctly.** Anything else gives itself away within milliseconds, and the
 *    request has no effect on it.
 * 3. Complete a real handshake with the target THROUGH the tunnel.
 *
 * Stage 3 cannot be skipped. Some proxies do not check upstream reachability
 * before answering, so they will happily agree at stage 2 — accepting that as
 * proof produces a confident "reachable" while the machine is offline.
 */
export async function viaProxy(target: Target, proxyUrl: string, options: Options = {}): Promise<Result> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  // Stages 1 and 2 — shared with the in-process route so a candidate that
  // passes here cannot tunnel differently when it carries real traffic.
  const tunnel = await NetTunnel.open(proxyUrl, `${target.host}:${target.port}`, timeoutMs)
  if (!tunnel.ok) return { ok: false, stage: tunnel.stage, reason: tunnel.reason }

  // Stage 3. Cannot be skipped: some proxies answer the tunnel request without
  // ever checking whether they can reach anything, so stopping at stage 2 would
  // report "reachable" on a machine with no working route at all.
  return new Promise<Result>((resolve) => {
    let settled = false
    const secure = tls.connect({ socket: tunnel.socket, servername: target.host, ...options.tls })
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      secure.destroy()
      tunnel.socket.destroy()
      resolve(result)
    }
    secure.setTimeout(timeoutMs, () => finish({ ok: false, stage: "handshake", reason: `timed out after ${timeoutMs}ms` }))
    secure.once("secureConnect", () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
    secure.once("error", (err: unknown) => finish({ ok: false, stage: "handshake", reason: reasonOf(err) }))
  })
}

/**
 * Is anything listening on this local port?
 *
 * Used only to skip candidates cheaply before the full three stages — never as
 * evidence of anything on its own. A closed port refuses instantly on loopback,
 * so the whole candidate list costs about nothing on a machine with no proxy.
 */
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
