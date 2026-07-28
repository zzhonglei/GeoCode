import { describe, expect, test } from "bun:test"
import net from "node:net"
import { NetRanking } from "@/geo/net/ranking"
import type { RankedEndpoint, Route } from "@/geo/net/types"

/* Ordering a set of interchangeable endpoints (docs/GEOKERNEL.md §3.3 端点排名).
 *
 * The ranking is Net's FINISHED answer: a consumer walks it as given and
 * re-shapes none of it (§8.3). Everything that decides the sequence therefore
 * has to be decided here, and this is where those decisions are held. What the
 * probes themselves prove belongs to the probe tests; these are about the
 * order that comes out. */

const DIRECT: Route = { kind: "direct" }
const PROXY: Route = { kind: "proxy", url: "http://127.0.0.1:1" }

const pair = (endpoint: string, latencyMs: number, route: Route = DIRECT): RankedEndpoint => ({
  endpoint,
  route,
  routeId: route.kind === "direct" ? "direct" : `proxy:${route.url}`,
  latencyMs,
})

/** A port with nothing behind it, so a real probe there fails fast and locally. */
function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer(() => {})
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

describe("net endpoint ranking", () => {
  test("a pair that failed its measurement is parked at the back, never dropped", () => {
    const ordered = NetRanking.order([
      pair("https://slow.example/x", 90),
      pair("https://quiet.example/x", Number.POSITIVE_INFINITY),
      pair("https://fast.example/x", 20),
    ])
    // The probe is a handshake with a short timeout, so a pair that is slow to
    // greet — or behind a link that hiccuped during the measurement — is not a
    // dead pair. A measurement is evidence about the path, not a permit to use
    // it, so what it produces is an ORDER and never a shorter pool.
    expect(ordered.map((entry) => entry.endpoint)).toEqual([
      "https://fast.example/x",
      "https://slow.example/x",
      "https://quiet.example/x",
    ])
  })

  test("an endpoint appears once, by its best route", () => {
    const ordered = NetRanking.order([
      pair("https://busy.example/x", 10, PROXY),
      pair("https://busy.example/x", 30),
      pair("https://other.example/x", 40),
    ])
    // The answer is a list of ENDPOINTS. The road changes; the destination does
    // not — so handing a consumer the same host again by another route is not a
    // second chance, it is the same stall paid twice. Measured live against the
    // public Overpass pool: two unhealthy hosts, four entries, four minutes.
    expect(ordered.map((entry) => entry.endpoint)).toEqual(["https://busy.example/x", "https://other.example/x"])
    // And the route kept is the quickest one measured for that endpoint.
    expect(ordered[0]!.routeId).toBe("proxy:http://127.0.0.1:1")
  })

  test("an endpoint reachable by only one of its routes keeps that one", () => {
    const ordered = NetRanking.order([
      pair("https://blocked.example/x", Number.POSITIVE_INFINITY),
      pair("https://blocked.example/x", 60, PROXY),
    ])
    // The case the route dimension exists for: direct is blocked, the proxy is
    // not. Collapsing to one entry per endpoint must not collapse to the wrong
    // one.
    expect(ordered).toHaveLength(1)
    expect(ordered[0]!.latencyMs).toBe(60)
    expect(ordered[0]!.route.kind).toBe("proxy")
  })

  test("a pool where nothing answers still comes back whole", async () => {
    const first = await deadPort()
    const second = await deadPort()
    const ranked = await NetRanking.rank([`https://127.0.0.1:${first}/x`, `https://127.0.0.1:${second}/x`], [DIRECT], {
      timeoutMs: 500,
    })
    // The consumer's own failover is what turns this into a real answer;
    // handing it an empty list would leave it nothing to fail over across.
    expect(ranked).toHaveLength(2)
    expect(ranked.every((entry) => entry.latencyMs === Number.POSITIVE_INFINITY)).toBe(true)
  })
})
