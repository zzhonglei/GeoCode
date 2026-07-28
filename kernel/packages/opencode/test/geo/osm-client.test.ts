import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { OsmClient } from "@/geo/osm/client"
import { OsmHttp } from "@/geo/osm/http"
import { testEffect } from "../lib/effect"

/* The OSM reliability layer (docs/GEOKERNEL.md §6.3).
 *
 * The real path was exercised against the live services — and the very first
 * request came back HTTP 504 carrying an HTML error page, which is the third
 * failure shape below arriving unprompted. These tests script the four shapes
 * so each one's handling is pinned rather than waited for.
 */

type Scripted =
  | { readonly status: number; readonly body: string }
  | { readonly error: OsmHttp.OsmHttpError }
  | { readonly abort: true }

/** An HTTP layer that answers per endpoint host, recording the order it was asked. */
function scriptedHttp(byHost: Record<string, Scripted | Scripted[]>) {
  const asked = Ref.makeUnsafe<string[]>([])
  const routes = Ref.makeUnsafe<string[]>([])
  const counts = new Map<string, number>()
  const layer = Layer.succeed(
    OsmHttp.Service,
    OsmHttp.Service.of({
      request: (input) =>
        Effect.gen(function* () {
          const host = new URL(input.url).hostname
          yield* Ref.update(asked, (all) => [...all, host])
          yield* Ref.update(routes, (all) => [...all, input.route.kind])
          const entry = byHost[host] ?? { status: 200, body: "{}" }
          const seen = counts.get(host) ?? 0
          counts.set(host, seen + 1)
          const scripted = Array.isArray(entry) ? (entry[Math.min(seen, entry.length - 1)] as Scripted) : entry
          if ("abort" in scripted) return yield* Effect.fail(new DOMException("aborted", "AbortError"))
          if ("error" in scripted) return yield* Effect.fail(scripted.error)
          return { status: scripted.status, body: scripted.body }
        }),
    }),
  )
  return { layer, asked, routes }
}

/** A Net whose ranking is fixed, so endpoint order under test is deterministic. */
function scriptedNet(order: readonly { host: string; route?: NetTypes.Route }[]) {
  const rankings = Ref.makeUnsafe(0)
  const layer = Layer.succeed(
    GeoNet.Service,
    GeoNet.Service.of({
      register: () => Effect.void,
      registerGroup: () => Effect.void,
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () => Effect.succeed({ state: "idle" }) as never,
      route: () => Effect.succeed({ kind: "direct" } as NetTypes.Route),
      ranking: () =>
        Effect.gen(function* () {
          yield* Ref.update(rankings, (n) => n + 1)
          return order.map((entry, index) => ({
            endpoint: `https://${entry.host}/api/interpreter`,
            route: entry.route ?? ({ kind: "direct" } as NetTypes.Route),
            routeId: entry.route?.kind === "proxy" ? "proxy:p:1" : "direct",
            latencyMs: index * 10,
          }))
        }),
    }),
  )
  return { layer, rankings }
}

const graph = (http: Layer.Layer<OsmHttp.Service>, net: Layer.Layer<GeoNet.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([OsmClient.node]), [
      [OsmHttp.node, http],
      [GeoNet.node, net],
    ]),
  )

const OK = { status: 200, body: JSON.stringify({ elements: [{ id: 1 }] }) }

describe("osm endpoint pool", () => {
  test("holds only full-planet instances", () => {
    // A region-limited instance answers successfully with data that silently
    // excludes everything outside its region — worse than an error, because
    // nothing about the response says so (§6.3). These are the known regional
    // ones; the guard is here so adding an endpoint means thinking about it.
    const regional = ["overpass.osm.ch", "overpass.osm.rambler.ru", "overpass.nchc.org.tw"]
    for (const endpoint of OsmClient.OVERPASS_ENDPOINTS) {
      const host = new URL(endpoint).hostname
      expect(regional).not.toContain(host)
      expect(endpoint.startsWith("https://")).toBe(true)
    }
    expect(OsmClient.OVERPASS_ENDPOINTS.length).toBeGreaterThan(3)
  })
})

describe("osm failover", () => {
  {
    const http = scriptedHttp({
      "a.example": { status: 504, body: "<html>busy</html>" },
      "b.example": OK,
    })
    const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
    const it = graph(http.layer, net.layer)

    it.live("an HTTP error moves to the next endpoint", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(new URL(result.endpoint).hostname).toBe("b.example")
        expect(yield* Ref.get(http.asked)).toEqual(["a.example", "b.example"])
      }),
    )
  }

  {
    // The shape a status check misses entirely — and the one the live service
    // handed us on the first real request: a body that is not JSON.
    const http = scriptedHttp({
      "a.example": { status: 200, body: "<html>Gateway Time-out</html>" },
      "b.example": OK,
    })
    const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
    const it = graph(http.layer, net.layer)

    it.live("a 200 carrying an error page is a failure too", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(new URL(result.endpoint).hostname).toBe("b.example")
      }),
    )
  }

  {
    const http = scriptedHttp({
      "a.example": { status: 200, body: JSON.stringify({ elements: [], remark: "runtime error: Query timed out" }) },
      "b.example": OK,
    })
    const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
    const it = graph(http.layer, net.layer)

    it.live("a soft failure is surfaced, not failed over", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        // The data that arrived is usable, so switching endpoints would only
        // cost another request. But the call is incomplete and has to say so —
        // status code plus parse would have called this a clean success, which
        // is the most dangerous of the four shapes (§6.3 第四种失败).
        expect(new URL(result.endpoint).hostname).toBe("a.example")
        expect(result.remark).toContain("timed out")
        expect(yield* Ref.get(http.asked)).toEqual(["a.example"])
      }),
    )
  }

  {
    const oversized = new OsmHttp.OsmHttpError("the response passed 200 MB", 200, "a", true)
    const http = scriptedHttp({ "a.example": { error: oversized }, "b.example": OK })
    const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
    const it = graph(http.layer, net.layer)

    it.live("an oversized body stops the call instead of touring the pool", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const outcome = yield* Effect.result(osm.overpass("out geom;"))
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure") expect(outcome.failure.kind).toBe("oversized")
        // Another endpoint would produce the same enormous answer; only the
        // caller asking for less can fix it.
        expect(yield* Ref.get(http.asked)).toEqual(["a.example"])
      }),
    )
  }

  {
    const http = scriptedHttp({ "a.example": { abort: true }, "b.example": OK })
    const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
    const it = graph(http.layer, net.layer)

    it.live("a cancelled call does not spend the pool", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const outcome = yield* Effect.result(osm.overpass("out count;"))
        expect(outcome._tag).toBe("Failure")
        // Cancellation says nothing about the endpoint's health.
        expect(yield* Ref.get(http.asked)).toEqual(["a.example"])
      }),
    )
  }

  {
    const http = scriptedHttp({ "a.example": { status: 500, body: "" } })
    const net = scriptedNet([{ host: "a.example" }])
    const it = graph(http.layer, net.layer)

    it.live(
      "every endpoint failing carries what each one said",
      () =>
        Effect.gen(function* () {
          const osm = yield* OsmClient.Service
          const outcome = yield* Effect.result(osm.overpass("out count;"))
          expect(outcome._tag).toBe("Failure")
          if (outcome._tag === "Failure") {
            expect(outcome.failure.kind).toBe("exhausted")
            // Not "everything failed" — which host, over which route, with
            // what answer. That is what makes a bad round diagnosable.
            expect(outcome.failure.attempts.length).toBe(3)
            expect(outcome.failure.attempts[0]).toContain("a.example")
            expect(outcome.failure.attempts[0]).toContain("HTTP 500")
          }
        }),
      { timeout: 30000 },
    )
  }
})

describe("osm endpoint stickiness", () => {
  const http = scriptedHttp({
    "a.example": { status: 503, body: "" },
    "b.example": OK,
  })
  const net = scriptedNet([{ host: "a.example" }, { host: "b.example" }])
  const it = graph(http.layer, net.layer)

  it.live("the endpoint that worked is where the next call starts", () =>
    Effect.gen(function* () {
      const osm = yield* OsmClient.Service
      yield* osm.overpass("out count;")
      yield* osm.overpass("out count;")
      // First call walks past the sick one; the second starts where the last
      // success was, instead of paying that failure again (§6.3 粘性端点).
      expect(yield* Ref.get(http.asked)).toEqual(["a.example", "b.example", "b.example"])
    }),
  )
})

describe("osm routing", () => {
  const http = scriptedHttp({ "a.example": { status: 500, body: "" }, "b.example": OK })
  const net = scriptedNet([
    { host: "a.example", route: { kind: "proxy", url: "http://127.0.0.1:7890" } },
    { host: "b.example" },
  ])
  const it = graph(http.layer, net.layer)

  it.live("each endpoint travels by its own route", () =>
    Effect.gen(function* () {
      const osm = yield* OsmClient.Service
      yield* osm.overpass("out count;")
      // The ranking is a sequence of PAIRS: failing over changes the route
      // along with the endpoint. A single global setting would make the
      // measurement that produced the order meaningless (§6.3 路由逐次施加).
      expect(yield* Ref.get(http.routes)).toEqual(["proxy", "direct"])
    }),
  )
})

describe("osm ranking source", () => {
  const http = scriptedHttp({ "a.example": OK })
  const net = scriptedNet([{ host: "a.example" }])
  const it = graph(http.layer, net.layer)

  it.live("the order is asked of Net on every call, never cached here", () =>
    Effect.gen(function* () {
      const osm = yield* OsmClient.Service
      yield* osm.overpass("out count;")
      yield* osm.overpass("out count;")
      // Net invalidates its own ranking when the route identity changes and
      // re-measures on the next request. Caching a copy here would mean
      // holding an order that a network change has already retired (§6.3
      // 失效由 Net 驱动).
      expect(yield* Ref.get(net.rankings)).toBe(2)
    }),
  )
})
