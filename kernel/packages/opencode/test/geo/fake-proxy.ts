import net from "node:net"

/* --- GeoCode: the only CONNECT proxy stub; a second copy would drift from its fixes (docs/CONVENTIONS.md §7). --- */

export interface FakeProxyOptions {
  /** Pipe the tunnel to this port. Omit to answer the CONNECT and then stay silent. */
  readonly forwardPort?: number
  /** Anything but 200 is refused and the socket closed. */
  readonly status?: number
}

export async function fakeProxy(options: FakeProxyOptions = {}): Promise<number> {
  const status = options.status ?? 200
  const server = net.createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      socket.pause() // Flowing with no reader drops whatever arrives before the pipe below.
      socket.write(`HTTP/1.1 ${status} ${status === 200 ? "Connection Established" : "Forbidden"}\r\n\r\n`)
      if (status !== 200) return void socket.end()
      if (options.forwardPort === undefined) return

      const headerEnd = chunk.indexOf("\r\n\r\n")
      const leftover = headerEnd < 0 ? Buffer.alloc(0) : chunk.subarray(headerEnd + 4)
      const upstream = net.connect({ host: "127.0.0.1", port: options.forwardPort })
      if (leftover.length > 0) upstream.write(leftover)
      socket.pipe(upstream)
      upstream.pipe(socket)
      upstream.on("error", () => socket.destroy())
    })
    socket.on("error", () => {})
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  )
}
