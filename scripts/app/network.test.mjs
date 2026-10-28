// The network check's own test: the proxy must keep the host of each request it passes on and close with a tunnel
// still open, and a request for this machine that went through it must be told apart.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { networkCheck, recordingProxy } from './network.mjs'

test('the proxy keeps the host of a request and of a tunnel, and closes with the tunnel open', async () => {
  // The far side: a server on this machine that answers anything.
  const far = http.createServer((request, response) => response.end('far'))
  await new Promise((resolve) => far.listen(0, '127.0.0.1', resolve))
  const port = far.address().port
  const proxy = await recordingProxy()
  let tunnel
  try {
    const { port: proxyPort } = new URL(proxy.url)
    const answer = await new Promise((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: `http://localhost:${port}/` }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolve(body))
        })
        .on('error', reject),
    )
    assert.equal(answer, 'far')
    tunnel = net.connect(Number(proxyPort), '127.0.0.1')
    await new Promise((resolve) => tunnel.once('connect', resolve))
    tunnel.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    await new Promise((resolve) => tunnel.once('data', resolve))
    assert.deepEqual([...proxy.hosts].sort(), ['127.0.0.1', 'localhost'])
    // An open tunnel must not hold the close up.
    const closed = await Promise.race([proxy.close().then(() => true), new Promise((r) => setTimeout(r, 2000, false))])
    assert.ok(closed)
  } finally {
    // Whatever failed: an open tunnel would keep the test running.
    tunnel?.destroy()
    await proxy.close()
    far.closeAllConnections()
    far.close()
  }
})

test('a run reports the hosts beyond this machine and those on it that went through the proxy', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-network-'))
  const near = http.createServer((request, response) => response.end('near'))
  await new Promise((resolve) => near.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(home, '.zshrc'), '')
    const check = await networkCheck({ home })
    const proxy = /HTTP_PROXY=(\S+)/.exec(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'))[1]
    const { port } = new URL(proxy)
    // A request for this machine that went through the proxy, as one would if the proxy settings lost loopback.
    await new Promise((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port, path: `http://127.0.0.1:${near.address().port}/`, agent: false }, (response) =>
          response.resume().on('end', resolve),
        )
        .on('error', reject),
    )
    assert.deepEqual(await check.after(), { outside: [], local: ['127.0.0.1'] })
  } finally {
    near.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
