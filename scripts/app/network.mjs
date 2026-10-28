// Where the app connects to beyond this machine. Its kernel, its server and its Python environment reach the network
// through the proxy the environment names: the check names one of its own in the sandbox's .zshrc, which passes each
// request on and keeps the host it was for. The window goes through Chromium, which follows the system's settings
// instead, so what it reaches is not seen here; nor is a connection made past the proxy.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

const LOOPBACK = /^(127\.|::1$|localhost$)/

/** A proxy on this machine that passes each request on and keeps the host it was for. */
export const recordingProxy = async () => {
  const hosts = new Set()
  // Every socket, tunnels included, to end them all on close: a tunnel would keep the server open for ever.
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    // A plain HTTP request names its whole URL.
    let target
    try {
      target = new URL(request.url)
    } catch {
      response.writeHead(400).end()
      return
    }
    hosts.add(target.hostname)
    // Without a pool of its own connections, which would outlive the proxy.
    const options = { method: request.method, headers: request.headers, agent: false }
    const onward = http.request(target, options, (answer) => {
      response.writeHead(answer.statusCode, answer.headers)
      answer.pipe(response)
    })
    onward.on('error', () => response.headersSent || response.writeHead(502).end())
    request.pipe(onward)
  })
  // HTTPS asks for a tunnel to host:port.
  server.on('connect', (request, socket, head) => {
    const [host, port] = request.url.split(/:(?=\d+$)/)
    hosts.add(host.replace(/^\[|\]$/g, ''))
    const onward = net.connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      onward.write(head)
      onward.pipe(socket)
      socket.pipe(onward)
    })
    // Either side ending ends the other.
    const end = () => {
      onward.destroy()
      socket.destroy()
    }
    for (const side of [onward, socket]) side.on('error', end).on('close', end)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hosts,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * The network check of one run, made before the app starts, as it names the proxy in the sandbox. `after`, once the
 * app has quit, answers the hosts beyond this machine that were asked for through the proxy, and those on this
 * machine that were: they should have been asked for directly, as a proxy elsewhere could not reach them.
 */
export const networkCheck = async (box) => {
  const proxy = await recordingProxy()
  fs.appendFileSync(path.join(box.home, '.zshrc'), `export HTTP_PROXY=${proxy.url} HTTPS_PROXY=${proxy.url}\n`)
  return {
    after: async () => {
      await proxy.close()
      const hosts = [...proxy.hosts].sort()
      return {
        outside: hosts.filter((host) => !LOOPBACK.test(host)),
        local: hosts.filter((host) => LOOPBACK.test(host)),
      }
    },
  }
}
