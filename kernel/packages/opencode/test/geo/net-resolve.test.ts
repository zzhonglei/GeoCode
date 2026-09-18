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
import { fakeProxy } from "./fake-proxy"

/* Path resolution, the two route forms and credential redaction (docs/GEOKERNEL.md §3.3). */

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
    // A working proxy is offered as a candidate and never reached: `resolve` returns on a successful direct probe.
    const proxyPort = await fakeProxy({ forwardPort: target.port })

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
    // Same host so the certificate still matches, but a port nothing answers on: direct fails where the proxy works.
    const target: Target = { id: "test", host: "localhost", port: await closedPort() }
    const proxyPort = await fakeProxy({ forwardPort: real.port })

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
    expect(NetDiscovery.declared({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toBeUndefined()
    expect(NetDiscovery.declared({ HTTPS_PROXY: "127.0.0.1:7890" })).toBe("http://127.0.0.1:7890")
  })

  test("and skipping it is now said out loud, named the way a route is named", () => {
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toEqual(["socks5:127.0.0.1:1080"])
    expect(NetDiscovery.skipped({ HTTPS_PROXY: "http://127.0.0.1:7890" })).toEqual([])
    expect(NetDiscovery.skipped({})).toEqual([])

    // The scheme lowercased and kept, since it is the reason the declaration was refused.
    expect(NetDiscovery.skipped({ ALL_PROXY: "SOCKS5H://proxy.example.com:1080" })).toEqual([
      "socks5h:proxy.example.com:1080",
    ])
    // A port nobody wrote is not invented: 1080 is a convention, not part of this declaration.
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5://127.0.0.1" })).toEqual(["socks5:127.0.0.1"])
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5://[::1]:1080" })).toEqual(["socks5:[::1]:1080"])

    // Both parse with an empty host — no `//` in the first, nothing after it in the second — leaving nothing to name.
    // The first also loses its scheme, since without `//` the text before the colon is not provably one.
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5:127.0.0.1:1080" })).toEqual(["socks:unparseable"])
    expect(NetDiscovery.skipped({ ALL_PROXY: "socks5://" })).toEqual(["socks5:unparseable"])
  })

  test("no credential can be present, because none is ever taken", () => {
    const secrets = [
      ["socks5://alice:hunter2@10.0.0.9:1080", "socks5:10.0.0.9:1080"],
      // A `/` in the password: `new URL` throws.
      ["socks5://alice:pa/ss@10.0.0.9:1080", "socks5:unparseable"],
      // A `/` in the username parses instead, to the host `al`, so the @-without-a-user check is what catches it.
      ["socks5://al/ice:secret@10.0.0.9:1080", "socks5:unparseable"],
      // No `//` at all parses too, with an empty host and no username, so a try/catch alone would return `socks5:`.
      ["socks5:alice:hunter2@10.0.0.9:1080", "socks:unparseable"],
      ["socks5://alice:p@ssw0rd@10.0.0.9:1080", "socks5:10.0.0.9:1080"],
      // A username is what `^socks` matched here, and the scheme is read only ahead of `//` so that it stays out.
      ["socksalice:hunter2@10.0.0.9:1080", "socks:unparseable"],
      ["socksalice:pw@10.0.0.9:1080://x", "socks:unparseable"],
    ] as const

    for (const [declared, expected] of secrets) {
      const published = NetDiscovery.skipped({ ALL_PROXY: declared })
      expect(published).toEqual([expected])
      for (const item of published) {
        for (const secret of ["hunter2", "secret", "pa/ss", "p@ssw0rd", "alice", "al/ice", "socksalice"]) {
          expect(item).not.toContain(secret)
        }
      }
    }
  })

  test("the same value is never reported twice, however many variables carry it", () => {
    expect(
      NetDiscovery.skipped({ ALL_PROXY: "socks5://127.0.0.1:1080", all_proxy: "socks5://127.0.0.1:1080" }),
    ).toEqual(["socks5:127.0.0.1:1080"])
  })
})

describe("net route forms", () => {
  test("the proxy form writes every spelling a subprocess might read", () => {
    const env = NetRoute.subprocessEnv({ kind: "proxy", url: "http://127.0.0.1:7890" }, {})
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    expect(env.https_proxy).toBe("http://127.0.0.1:7890")
    expect(env.all_proxy).toBe("http://127.0.0.1:7890")
    expect(env.NO_PROXY).toContain("127.0.0.1")
  })

  test("the direct form blanks inherited variables instead of ignoring them", () => {
    const env = NetRoute.subprocessEnv({ kind: "direct" }, { HTTPS_PROXY: "http://inherited:7890" })
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
    expect(NetRedact.url("not a url //bob:secret@host:1/")).not.toContain("secret")
  })

  test("a value with no credentials is returned untouched", () => {
    expect(NetRedact.url("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890")
    expect(NetRedact.url(undefined)).toBeUndefined()
  })

  test("the four shapes that used to come back with the password still in them", () => {
    const leaking = [
      "socks5://alice:pa/ss@10.0.0.9:1080",
      "socks5://al/ice:secret@10.0.0.9:1080",
      "socks5:alice:hunter2@10.0.0.9:1080",
      "alice:hunter2@10.0.0.9:1080",
    ]
    for (const value of leaking) {
      const redacted = NetRedact.url(value)
      for (const secret of ["hunter2", "pa/ss", "secret", "alice"]) {
        expect(redacted).not.toContain(secret)
      }
      expect(redacted).toContain("10.0.0.9:1080")
    }

    // Why `alice` is in that list: `alice:` is a syntactically perfect scheme, so a rule that keeps "the scheme"
    // keeps the username of a declaration written without one.
    expect(NetRedact.url("alice:hunter2@10.0.0.9:1080")).toBe("10.0.0.9:1080")
    expect(NetRedact.url("socks5:alice:hunter2@10.0.0.9:1080")).toBe("socks5:10.0.0.9:1080")
  })

  test("nothing with an @ still in it is ever handed back", () => {
    // An `@` surviving redaction means something in front of it — which is where credentials sit — was not understood.
    for (const value of [
      "socks5://alice:hunter2@10.0.0.9:1080",
      "socks5://alice:pa/ss@10.0.0.9:1080",
      "http://alice:hunter2@proxy.example:8080",
      "not a url //bob:secret@host:1/",
      "https://u:p@a@b@host:443",
    ]) {
      expect(NetRedact.url(value)).not.toContain("@")
    }
  })

  test("environment values go through the same filter, one by one", () => {
    const cleaned = NetRedact.env({
      ALL_PROXY: "socks5://alice:pa/ss@10.0.0.9:1080",
      GDAL_DATA: "/opt/gdal",
    })
    expect(cleaned.ALL_PROXY).not.toContain("pa/ss")
    expect(cleaned.GDAL_DATA).toBe("/opt/gdal")
  })
})
