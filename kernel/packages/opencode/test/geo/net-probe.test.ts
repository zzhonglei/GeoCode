import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { NetProbe } from "@/geo/net/probe"
import type { Target } from "@/geo/net/types"

/* The probes behind every reachability verdict (docs/GEOKERNEL.md §3.3 探针规格).
 *
 * Everything here runs against servers this file starts. That is deliberate:
 * a network test that needs the internet tells you about the internet, not
 * about the code — and the properties worth locking (what each of the three
 * stages proves, and that certificate verification stays on) are all reachable
 * offline. */

/**
 * Generated at module load, not in `beforeAll`: `test.skipIf` is evaluated when
 * the tests are registered, which happens first. Deciding to skip on a value
 * that a hook has not yet produced silently skips everything.
 */
const material = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-net-probe-"))
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(dir, "key.pem"),
      "-out", path.join(dir, "cert.pem"),
      "-days", "2", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  )
  if (result.status !== 0) return { dir, certificate: undefined, key: undefined }
  return {
    dir,
    certificate: fs.readFileSync(path.join(dir, "cert.pem")),
    key: fs.readFileSync(path.join(dir, "key.pem")),
  }
})()

const certificate = material.certificate
const key = material.key

afterAll(() => fs.rmSync(material.dir, { recursive: true, force: true }))

const servers: (net.Server | tls.Server)[] = []
afterAll(() => servers.forEach((server) => server.close()))

function listen(server: net.Server | tls.Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)))
}

/** A TLS endpoint standing in for a remote service. */
async function tlsTarget(): Promise<Target> {
  const server = tls.createServer({ cert: certificate!, key: key! }, (socket) => socket.end())
  const port = await listen(server)
  return { id: "test", host: "localhost", port }
}

/** A plain TCP service that is NOT a proxy, and records what was sent to it. */
async function plainService(): Promise<{ port: number; received: () => string }> {
  let received = ""
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      received += chunk.toString()
      // An echo service: it answers, but not in the proxy's protocol.
      socket.write("hello from something that is not a proxy\n")
    })
  })
  const port = await listen(server)
  return { port, received: () => received }
}

/**
 * A proxy whose CONNECT handling is configurable.
 *
 * `tunnel: true` pipes the connection through to `forwardPort`, which is what a
 * working proxy does. `tunnel: false` answers 200 and then does nothing — the
 * behaviour of a proxy that agrees before checking whether it can actually
 * reach anything.
 */
async function fakeProxy(options: { tunnel: boolean; forwardPort?: number; status?: number }): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      const status = options.status ?? 200
      socket.write(`HTTP/1.1 ${status} ${status === 200 ? "Connection Established" : "Forbidden"}\r\n\r\n`)
      if (status !== 200) return void socket.end()
      if (!options.tunnel) return
      const upstream = net.connect({ host: "127.0.0.1", port: options.forwardPort! }, () => {
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on("error", () => socket.destroy())
    })
    socket.on("error", () => {})
  })
  return listen(server)
}

describe("net probe", () => {
  test("stage 1 fails when nothing is listening", async () => {
    // Port 1 on loopback: reserved, and refused instantly.
    const result = await NetProbe.viaProxy({ id: "t", host: "localhost", port: 443 }, "http://127.0.0.1:1", {
      timeoutMs: 2000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stage).toBe("connect")
  })

  test("stage 2 unmasks a non-proxy service without disturbing it", async () => {
    const service = await plainService()
    const result = await NetProbe.viaProxy({ id: "t", host: "localhost", port: 443 }, `http://127.0.0.1:${service.port}`, {
      timeoutMs: 3000,
    })

    // Something was listening, so stage 1 passed; only the protocol question
    // separates a proxy from any other local service.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stage).toBe("tunnel")

    // The request reached it and was simply not understood. Asking is harmless:
    // that is what makes it acceptable to ask a short list of ports at all.
    expect(service.received()).toContain("CONNECT")
  })

  test("stage 2 reports a proxy that refuses the tunnel", async () => {
    const port = await fakeProxy({ tunnel: false, status: 403 })
    const result = await NetProbe.viaProxy({ id: "t", host: "localhost", port: 443 }, `http://127.0.0.1:${port}`, {
      timeoutMs: 3000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.stage).toBe("tunnel")
      expect(result.reason).toContain("403")
    }
  })

  test("stage 3 is not skippable: a proxy that agrees but tunnels nowhere fails", async () => {
    // THE test of the three-stage design. This proxy answers 200 without ever
    // checking whether it can reach anything — real ones do this. Stopping at
    // stage 2 would report "reachable" on a machine with no working route at
    // all, which is the single most misleading conclusion this module could
    // reach (§3.3).
    const port = await fakeProxy({ tunnel: false })
    const result = await NetProbe.viaProxy({ id: "t", host: "localhost", port: 443 }, `http://127.0.0.1:${port}`, {
      timeoutMs: 2000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stage).toBe("handshake")
  })

  test.skipIf(!certificate)("the direct probe refuses an untrusted certificate", async () => {
    const target = await tlsTarget()

    // No CA supplied, so this is the production configuration. The server's
    // certificate is self-signed and must be rejected: a probe that accepted it
    // would agree with anything answering on the port, which is worse than not
    // probing (§3.3).
    const result = await NetProbe.direct(target, { timeoutMs: 3000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/self.?signed|unable to verify|UNABLE_TO_VERIFY/i)
  })

  test.skipIf(!certificate)("the direct probe completes a real handshake with a trusted endpoint", async () => {
    const target = await tlsTarget()
    const result = await NetProbe.direct(target, { timeoutMs: 3000, tls: { ca: [certificate!] } })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test.skipIf(!certificate)("all three stages pass through a working proxy", async () => {
    const target = await tlsTarget()
    const port = await fakeProxy({ tunnel: true, forwardPort: target.port })

    const result = await NetProbe.viaProxy(target, `http://127.0.0.1:${port}`, {
      timeoutMs: 5000,
      tls: { ca: [certificate!] },
    })

    // Reached the genuine endpoint THROUGH the tunnel — the only evidence that
    // actually justifies adopting a proxy.
    expect(result.ok).toBe(true)
  })

  test("a target written as an address returns a verdict instead of throwing", async () => {
    // SNI carries a host NAME; the runtime refuses an address outright. Passing
    // one through threw where the caller expected a verdict — and a thrown probe
    // is not a failed probe, it takes the monitor's fiber with it. Found by
    // running the real module against real proxy software; every offline target
    // in this file is a name, so nothing here would ever have caught it.
    const result = await NetProbe.direct({ id: "t", host: "127.0.0.1", port: 1 }, { timeoutMs: 1500 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("ECONNREFUSED")
  })

  test("an address target survives the proxy path too", async () => {
    const port = await fakeProxy({ tunnel: false })
    const result = await NetProbe.viaProxy({ id: "t", host: "203.0.113.1", port: 443 }, `http://127.0.0.1:${port}`, {
      timeoutMs: 1500,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stage).toBe("handshake")
  })

  test("listening() answers without claiming anything more", async () => {
    const service = await plainService()
    expect(await NetProbe.listening("127.0.0.1", service.port, 1000)).toBe(true)
    expect(await NetProbe.listening("127.0.0.1", 1, 1000)).toBe(false)
    // It says a socket opened. Whether that is a proxy is stage 2's question.
    expect(service.received()).toBe("")
  })
})
