import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import { OsmClient } from "@/geo/osm/client"
import { OsmHttp } from "@/geo/osm/http"
import type { NetTypes } from "@/geo/net/types"
import { testEffect } from "../lib/effect"

/* The reliability layer (docs/GEOKERNEL.md §6.3), over a scripted HTTP layer: who gets asked first, what counts as
 * a failure, and what a proxy changes. */

const OFFICIAL = "overpass-api.de"
const BACKUP_ONE = "lz4.overpass-api.de"
const BACKUP_TWO = "z.overpass-api.de"
const FIRST_MIRROR = "overpass.kumi.systems"

type Scripted =
  | { readonly status: number; readonly body: string }
  | { readonly error: OsmHttp.OsmHttpError }
  | { readonly abort: true }

/** An HTTP layer answering per host, recording the order and the route used. */
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
          // A host the script does not name is unreachable, so a stray success cannot satisfy a test whose
          // premise is that something failed.
          const entry: Scripted | Scripted[] = byHost[host] ?? {
            error: new OsmHttp.OsmHttpError("not in this test's script", undefined, input.url),
          }
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

/** A Net answering the one question the client asks it — has this machine got a proxy — and counting the asks. */
function scriptedNet(proxyUrl?: string) {
  const asks = Ref.makeUnsafe(0)
  const layer = Layer.succeed(
    GeoNet.Service,
    GeoNet.Service.of({
      register: () => Effect.void,
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () => Effect.succeed({ state: "idle" }) as never,
      route: () => Effect.succeed(undefined),
      proxy: () =>
        Effect.gen(function* () {
          yield* Ref.update(asks, (n) => n + 1)
          return proxyUrl
        }),
    }),
  )
  return { layer, asks }
}

const graph = (http: Layer.Layer<OsmHttp.Service>, net: Layer.Layer<GeoNet.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([OsmClient.node]), [
      [OsmHttp.node, http],
      [GeoNet.node, net],
    ]),
  )

const OK = { status: 200, body: JSON.stringify({ elements: [{ id: 1 }] }) }
const SLOW_TEST = { timeout: 60_000 }

describe("osm endpoint pool", () => {
  it_pool()
  function it_pool() {
    const it = graph(scriptedHttp({}).layer, scriptedNet().layer)

    it.effect("the official instance leads, mirrors follow", () =>
      Effect.sync(() => {
        const hosts = OsmClient.OVERPASS_ENDPOINTS.map((endpoint) => new URL(endpoint).hostname)
        expect(hosts.slice(0, 3)).toEqual([OFFICIAL, BACKUP_ONE, BACKUP_TWO])
        expect(hosts.slice(3).length).toBeGreaterThan(2)
      }),
    )

    it.effect("holds only full-planet instances", () =>
      Effect.sync(() => {
        // A region-limited instance answers about anywhere else with success and no data, and nothing in the
        // response says so (§6.3).
        const regional = ["overpass.osm.ch", "overpass.osm.rambler.ru", "overpass.nchc.org.tw"]
        for (const endpoint of OsmClient.OVERPASS_ENDPOINTS) {
          expect(regional).not.toContain(new URL(endpoint).hostname)
          expect(endpoint.startsWith("https://")).toBe(true)
        }
      }),
    )
  }
})

describe("osm failover", () => {
  {
    const http = scriptedHttp({ [OFFICIAL]: { status: 504, body: "<html>busy</html>" }, [BACKUP_ONE]: OK })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("an HTTP error moves to the next endpoint", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(new URL(result.endpoint).hostname).toBe(BACKUP_ONE)
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL, BACKUP_ONE])
      }),
    )
  }

  {
    const http = scriptedHttp({ [OFFICIAL]: { status: 200, body: "<html>rate limited</html>" }, [BACKUP_ONE]: OK })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("a 200 carrying an error page is a failure too", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(new URL(result.endpoint).hostname).toBe(BACKUP_ONE)
      }),
    )
  }

  {
    const remark = JSON.stringify({ elements: [], remark: "runtime error: Query timed out" })
    const http = scriptedHttp({ [OFFICIAL]: { status: 200, body: remark }, [BACKUP_ONE]: OK })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("a soft failure is surfaced, not failed over", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(new URL(result.endpoint).hostname).toBe(OFFICIAL)
        expect(result.remark).toContain("timed out")
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL])
      }),
    )
  }

  {
    const oversized = new OsmHttp.OsmHttpError("the response passed 200 MB", 200, OFFICIAL, true)
    const http = scriptedHttp({ [OFFICIAL]: { error: oversized }, [BACKUP_ONE]: OK })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("an oversized body stops the call instead of touring the pool", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const outcome = yield* Effect.result(osm.overpass("out geom;"))
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure") expect(outcome.failure.kind).toBe("oversized")
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL])
      }),
    )
  }

  {
    const http = scriptedHttp({ [OFFICIAL]: { abort: true }, [BACKUP_ONE]: OK })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("a cancelled call does not spend the pool", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const outcome = yield* Effect.result(osm.overpass("out count;"))
        expect(outcome._tag).toBe("Failure")
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL])
      }),
    )
  }

  {
    const http = scriptedHttp({
      [OFFICIAL]: { status: 503, body: "" },
      [BACKUP_ONE]: { status: 503, body: "" },
      [BACKUP_TWO]: { status: 503, body: "" },
      [FIRST_MIRROR]: OK,
    })
    const it = graph(http.layer, scriptedNet().layer)

    it.live("a mirror is reached only after the official tier has actually failed", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        const result = yield* osm.overpass("out count;")
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL, BACKUP_ONE, BACKUP_TWO, FIRST_MIRROR])
        expect(new URL(result.endpoint).hostname).toBe(FIRST_MIRROR)
      }),
    )
  }

  {
    const http = scriptedHttp({ [OFFICIAL]: { status: 500, body: "" } })
    const net = scriptedNet()
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
            expect(outcome.failure.attempts[0]).toContain(OFFICIAL)
            expect(outcome.failure.attempts[0]).toContain("HTTP 500")
            expect(outcome.failure.attempts.length).toBe(OsmClient.OVERPASS_ENDPOINTS.length * 2)
          }
          expect(yield* Ref.get(net.asks)).toBe(1)
        }),
      SLOW_TEST,
    )
  }

  {
    // Two attempts on one endpoint reach total failure, where the pool costs sixteen.
    const http = scriptedHttp({})
    const net = scriptedNet()
    const it = graph(http.layer, net.layer)

    it.live(
      "a call that failed everywhere makes the next one ask about the proxy again",
      () =>
        Effect.gen(function* () {
          const osm = yield* OsmClient.Service
          yield* Effect.result(osm.nominatim("武汉大学"))
          expect(yield* Ref.get(net.asks)).toBe(1)

          yield* Effect.result(osm.nominatim("武汉大学"))
          expect(yield* Ref.get(net.asks)).toBe(2)
        }),
      SLOW_TEST,
    )
  }
})

describe("osm endpoint stickiness", () => {
  const http = scriptedHttp({ [OFFICIAL]: { status: 503, body: "" }, [BACKUP_ONE]: OK })
  const it = graph(http.layer, scriptedNet().layer)

  it.live(
    "a run that fell through to a backup does not re-pay the leader every call",
    () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        yield* osm.overpass("out count;")
        yield* osm.overpass("out count;")
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL, BACKUP_ONE, BACKUP_ONE])
      }),
    SLOW_TEST,
  )
})

describe("osm routing", () => {
  {
    const http = scriptedHttp({ [OFFICIAL]: OK })
    const net = scriptedNet()
    const it = graph(http.layer, net.layer)

    it.live("no proxy on the machine means direct, and Net is asked once", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        yield* osm.overpass("out count;")
        yield* osm.overpass("out count;")
        expect(yield* Ref.get(http.routes)).toEqual(["direct", "direct"])
        // Asking sweeps the loopback ports (geo/net/discovery.ts), and a machine's proxy does not change between
        // two requests a second apart.
        expect(yield* Ref.get(net.asks)).toBe(1)
      }),
    )
  }

  {
    const http = scriptedHttp({ [OFFICIAL]: OK, "nominatim.openstreetmap.org": { status: 200, body: "[]" } })
    const net = scriptedNet()
    const it = graph(http.layer, net.layer)

    it.live("two services starting at once still ask about the proxy once", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        yield* Effect.all([osm.overpass("out count;"), osm.nominatim("武汉大学")], { concurrency: 2 })
        expect(yield* Ref.get(net.asks)).toBe(1)
      }),
    )
  }

  {
    const http = scriptedHttp({
      [OFFICIAL]: { status: 503, body: "" },
      [BACKUP_ONE]: OK,
      "nominatim.openstreetmap.org": { status: 200, body: "[]" },
    })
    const it = graph(http.layer, scriptedNet("http://127.0.0.1:7890").layer)

    it.live("a proxy on the machine is worn by every request, whichever server is asked", () =>
      Effect.gen(function* () {
        const osm = yield* OsmClient.Service
        yield* osm.overpass("out count;")
        yield* osm.nominatim("武汉大学")
        expect(yield* Ref.get(http.routes)).toEqual(["proxy", "proxy", "proxy"])
      }),
    )
  }
})
