export * as NetTunnel from "./tunnel"

import net from "node:net"

/* --- GeoCode: the CONNECT handshake, in one place (docs/GEOKERNEL.md §3.3).
 *
 * Two callers need it and must not drift apart: the probe, which asks whether a
 * candidate is a usable proxy, and the in-process route, which carries real
 * traffic through the adopted one. If they built their tunnels differently, a
 * candidate could pass the probe and then fail in use — the exact class of bug
 * the three-stage probe exists to prevent. --- */

export type Stage = "connect" | "tunnel"

export type Result =
  /** The tunnel is open. The socket is raw — the caller starts TLS over it. */
  | { readonly ok: true; readonly socket: net.Socket }
  | { readonly ok: false; readonly stage: Stage; readonly reason: string }

/** Header bytes a proxy may send before the terminator. Anything past this is not one. */
const MAX_HEAD = 8192

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * Ask a proxy to open a tunnel to `authority` (`host:port`).
 *
 * On success the socket is handed over still raw and with no listeners of ours
 * left on it, so the caller can start a TLS session across it. On failure the
 * socket is destroyed here.
 */
export function open(proxyUrl: string, authority: string, timeoutMs: number): Promise<Result> {
  let parsed: URL
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return Promise.resolve({ ok: false, stage: "connect", reason: "proxy address is not a URL" })
  }

  return new Promise<Result>((resolve) => {
    let settled = false
    let stage: Stage = "connect"
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || "80") })

    const deadline = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs)

    const fail = (reason: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve({ ok: false, stage, reason })
    }
    const succeed = () => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      // Hand the socket over clean: leftover listeners of ours would otherwise
      // keep firing into a promise that has already settled.
      socket.removeListener("error", onError)
      resolve({ ok: true, socket })
    }

    const onError = (err: unknown) => fail(reasonOf(err))
    socket.on("error", onError)

    socket.once("connect", () => {
      stage = "tunnel"
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
      if (parsed.username || parsed.password) {
        const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`)
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n")

      let head = ""
      const onData = (chunk: Buffer) => {
        head += chunk.toString("latin1")
        if (head.indexOf("\r\n\r\n") < 0) {
          // A proxy answers in one short write. Something still talking at this
          // length is not speaking the protocol at all.
          if (head.length > MAX_HEAD) fail("tunnel response has no header terminator")
          return
        }
        socket.removeListener("data", onData)
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? 0)
        if (status < 200 || status > 299) {
          fail(status ? `tunnel refused with status ${status}` : "not a proxy: unrecognised tunnel response")
          return
        }
        succeed()
      }
      socket.on("data", onData)
    })
  })
}
