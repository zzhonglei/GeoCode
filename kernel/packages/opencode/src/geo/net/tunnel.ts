export * as NetTunnel from "./tunnel"

import net from "node:net"

/* --- GeoCode: the one CONNECT handshake, shared by the probe and the in-process route so a candidate cannot pass
 * verification and then tunnel differently under real traffic (docs/GEOKERNEL.md §3.3). --- */

export type Stage = "connect" | "tunnel"

export type Result =
  /** The socket is raw — the caller starts TLS over it. */
  | { readonly ok: true; readonly socket: net.Socket }
  | { readonly ok: false; readonly stage: Stage; readonly reason: string }

/** Header bytes a proxy may send before the terminator; anything still talking past this is not one. */
const MAX_HEAD = 8192

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/** `authority` is `host:port`. On failure the socket is already destroyed; on success it is the caller's. */
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
    const succeed = (leftover: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.removeListener("error", onError)
      // Removing the reader does not stop the flow: bytes arriving before the caller starts TLS would reach nobody.
      socket.pause()
      if (leftover.length > 0) socket.unshift(leftover)
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

      let head = Buffer.alloc(0) // Bytes, so the terminator's offset survives back into the stream.
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const terminator = head.indexOf("\r\n\r\n")
        if (terminator < 0) {
          if (head.length > MAX_HEAD) fail("tunnel response has no header terminator")
          return
        }
        socket.removeListener("data", onData)
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head.toString("latin1", 0, terminator))?.[1] ?? 0)
        if (status < 200 || status > 299) {
          fail(status ? `tunnel refused with status ${status}` : "not a proxy: unrecognised tunnel response")
          return
        }
        succeed(head.subarray(terminator + 4))
      }
      socket.on("data", onData)
    })
  })
}
