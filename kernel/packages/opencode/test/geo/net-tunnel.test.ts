import { describe, expect, test } from "bun:test"
import net from "node:net"

import { NetTunnel } from "../../src/geo/net/tunnel"

/** Answers CONNECT, then sends `trailing` — in the same write when `coalesced`, otherwise a turn later. */
async function proxy(trailing: string, coalesced: boolean): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      const head = "HTTP/1.1 200 Connection Established\r\n\r\n"
      if (coalesced) return void socket.write(head + trailing)
      socket.write(head)
      setTimeout(() => socket.write(trailing), 10)
    })
    socket.on("error", () => {})
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  )
}

/** Reads without resuming, the way `tls.connect` does when the caller hands it this socket. */
const readFirst = (socket: net.Socket, timeoutMs: number) =>
  new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("<nothing arrived>"), timeoutMs)
    const attempt = () => {
      const chunk = socket.read()
      if (chunk === null) return
      clearTimeout(timer)
      socket.removeListener("readable", attempt)
      resolve(String(chunk))
    }
    socket.on("readable", attempt)
    attempt()
  })

/* The caller starts TLS over this socket a turn after `open` resolves. Both cases below are ways the
 * first record can be gone by then, and a handshake that never sees it waits out the probe timeout
 * rather than failing — which reads as an unreliable proxy instead of a bug here. */
describe("CONNECT tunnel", () => {
  test("keeps bytes the proxy sent in the same packet as the 200", async () => {
    const port = await proxy("SERVER-HELLO", true)
    const result = await NetTunnel.open(`http://127.0.0.1:${port}`, "example.test:443", 2000)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await readFirst(result.socket, 1000)).toBe("SERVER-HELLO")
    result.socket.destroy()
  })

  test("keeps bytes that arrive between the 200 and the caller reading", async () => {
    const port = await proxy("SERVER-HELLO", false)
    const result = await NetTunnel.open(`http://127.0.0.1:${port}`, "example.test:443", 2000)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await readFirst(result.socket, 1000)).toBe("SERVER-HELLO")
    result.socket.destroy()
  })
})
