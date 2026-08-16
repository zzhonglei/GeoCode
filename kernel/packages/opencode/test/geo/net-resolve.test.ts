import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { NetDiscovery } from "@/geo/net/discovery"
import { NetRedact } from "@/geo/net/redact"
import { NetResolver } from "@/geo/net/resolver"
import { NetRoute } from "@/geo/net/route"
import type { Target } from "@/geo/net/types"

/* Path resolution and the two route forms (docs/GEOKERNEL.md §3.3).
 *
 * The headline behaviour is an ordering claim — direct first, proxy only after
 * direct has failed — so the tests are built to be able to tell the two apart
 * rather than merely to see one of them work. */

const material = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-net-resolve-"))
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
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

const servers: (net.Server | tls.Server)[] = []
afterAll(() => {
  servers.forEach((server) => server.close())
  fs.rmSync(material.dir, { recursive: true, force: true })
})

function listen(server: net.Server | tls.Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  )
}

async function tlsTarget(): Promise<Target> {
  const server = tls.createServer({ cert: certificate!, key: key! }, (socket) => socket.end())
  return { id: "test", host: "localhost", port: await listen(server) }
}

/** A proxy that tunnels every CONNECT to one fixed port, whatever was asked for. */
async function proxyTo(forwardPort: number): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      const upstream = net.connect({ host: "127.0.0.1", port: forwardPort }, () => {
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on("error", () => socket.destroy())
    })
    socket.on("error", () => {})
  })
  return listen(server)
}

/** A port number nothing is listening on. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  )
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe("net path resolution", () => {
  test.skipIf(!certificate)("a working direct connection ends the search there", async () => {
    const target = await tlsTarget()
    // A perfectly good proxy is listed as a candidate. It must never be reached:
    // when direct works, proxy discovery does not start at all, which is what
    // keeps the whole mechanism invisible to users who do not need it (§3.3).
    const proxyPort = await proxyTo(target.port)

    const resolution = await NetResolver.resolve(target, {
      ports: [proxyPort],
      probeTimeoutMs: 3000,
      tls: { ca: [certificate!] },
    })

    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.route.kind).toBe("direct")
      expect(resolution.routeId).toBe("direct")
    }
  })

  test.skipIf(!certificate)("a failing direct connection falls back to a verified proxy", async () => {
    const real = await tlsTarget()
    // Same host so the certificate still matches, but a port nothing answers on:
    // direct fails, while the proxy tunnels to where the service really is.
    const target: Target = { id: "test", host: "localhost", port: await closedPort() }
    const proxyPort = await proxyTo(real.port)

    const resolution = await NetResolver.resolve(target, {
      ports: [proxyPort],
      probeTimeoutMs: 3000,
      tls: { ca: [certificate!] },
    })

    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.route.kind).toBe("proxy")
      expect(resolution.routeId).toBe(`proxy:127.0.0.1:${proxyPort}`)
    }
  })

  test.skipIf(!certificate)("a declared proxy is verified like any other candidate", async () => {
    const target: Target = { id: "test", host: "localhost", port: await closedPort() }
    const dead = await closedPort()

    // An environment variable states intent, not fact: it can name a proxy that
    // stopped running months ago. Adopting it unverified would turn a clean
    // "cannot reach this" into a confusing failure much further downstream.
    const resolution = await NetResolver.resolve(target, {
      env: { HTTPS_PROXY: `http://127.0.0.1:${dead}` },
      ports: [],
      probeTimeoutMs: 2000,
      tls: { ca: [certificate!] },
    })

    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.tried).toEqual(["direct"])
  })

  test("a SOCKS-only declaration is skipped rather than adopted", () => {
    // Consuming runtimes need an extra optional dependency to speak SOCKS and
    // raise without it — adopting one would break users whose direct connection
    // works today (§12).
    expect(NetDiscovery.declared({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toBeUndefined()
    expect(NetDiscovery.declared({ HTTPS_PROXY: "127.0.0.1:7890" })).toBe("http://127.0.0.1:7890")
  })

  test("and skipping it is now said out loud, with the credentials taken off", () => {
    /* Skipping is the right call; doing it in silence was not.
     *
     * A user whose network only works through that proxy was told "cannot be
     * reached" forever — the same three words a user with no network at all
     * gets — while the one fact explaining it was known here and dropped. §12
     * recorded the skip as a tradeoff and left this half open.
     */
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toEqual(["socks5://127.0.0.1:1080"])
    // Nothing to say when nothing was skipped: a field that is always present
    // is one an interface has to render around forever.
    expect(NetDiscovery.skipped({ HTTPS_PROXY: "http://127.0.0.1:7890" })).toEqual([])
    expect(NetDiscovery.skipped({})).toEqual([])

    // THE assertion. This is a FOURTH outward exit, and redact.ts says missing
    // any one of them is the same as not doing it at all — `ALL_PROXY` carrying
    // `user:password@` is ordinary, and this value is published to the
    // interface.
    const secret = NetDiscovery.skipped({ ALL_PROXY: "socks5://alice:hunter2@10.0.0.9:1080" })
    expect(secret).toHaveLength(1)
    expect(secret[0]).not.toContain("hunter2")
    expect(secret[0]).not.toContain("alice")
    // Host and port survive, which is the whole reason a user is told at all —
    // they have to recognise their own configuration in it.
    expect(secret[0]).toContain("10.0.0.9:1080")
    expect(secret[0]).toBe(NetRedact.url("socks5://alice:hunter2@10.0.0.9:1080"))
  })

  test("the same value is never reported twice, however many variables carry it", () => {
    // Declaring a proxy usually means exporting it under three names. Three
    // identical lines in a status panel reads as three problems.
    expect(
      NetDiscovery.skipped({ ALL_PROXY: "socks5://127.0.0.1:1080", all_proxy: "socks5://127.0.0.1:1080" }),
    ).toEqual(["socks5://127.0.0.1:1080"])
  })
})

describe("net route forms", () => {
  test("the proxy form writes every spelling a subprocess might read", () => {
    const env = NetRoute.subprocessEnv({ kind: "proxy", url: "http://127.0.0.1:7890" }, {})
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    expect(env.https_proxy).toBe("http://127.0.0.1:7890")
    expect(env.all_proxy).toBe("http://127.0.0.1:7890")
    // Loopback stays off the proxy, or a script's local callback never arrives.
    expect(env.NO_PROXY).toContain("127.0.0.1")
  })

  test("the direct form blanks inherited variables instead of ignoring them", () => {
    const env = NetRoute.subprocessEnv({ kind: "direct" }, { HTTPS_PROXY: "http://inherited:7890" })
    // Not injecting is not enough: an inherited value would keep sending the
    // subprocess through a proxy the resolver just decided against, so "direct"
    // would not be true (§3.3).
    expect(env.HTTPS_PROXY).toBe("")
  })

  test("the direct form stays empty when nothing was inherited", () => {
    expect(NetRoute.subprocessEnv({ kind: "direct" }, {})).toEqual({})
  })

  test("the in-process form is an agent for proxies and nothing for direct", () => {
    expect(NetRoute.agent({ kind: "direct" })).toBeUndefined()
    expect(NetRoute.agent({ kind: "proxy", url: "http://127.0.0.1:7890" })).toBeDefined()
  })
})

describe("net redaction", () => {
  test("credentials are stripped while host and port survive", () => {
    const redacted = NetRedact.url("http://alice:hunter2@proxy.example:8080")
    expect(redacted).toContain("proxy.example:8080")
    expect(redacted).not.toContain("hunter2")
    expect(redacted).not.toContain("alice")
  })

  test("an unparseable value still loses its credentials", () => {
    // Failing open here would leak exactly in the case most likely to be
    // malformed in the first place.
    expect(NetRedact.url("not a url //bob:secret@host:1/")).not.toContain("secret")
  })

  test("a value with no credentials is returned untouched", () => {
    expect(NetRedact.url("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890")
    expect(NetRedact.url(undefined)).toBeUndefined()
  })
})
