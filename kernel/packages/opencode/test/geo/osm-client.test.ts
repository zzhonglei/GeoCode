import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import { OsmClient } from "@/geo/osm/client"
import { OsmHttp } from "@/geo/osm/http"
import type { NetTypes } from "@/geo/net/types"
import { testEffect } from "../lib/effect"

/* The reliability layer (docs/GEOKERNEL.md §6.3).
 *
 * Everything here is scripted. Running these against the live services would
 * measure the internet on one machine on one day — which is exactly the
 * evidence this module must NOT be tuned to, since its whole job is to behave
 * for users whose networks look nothing like the author's. What is pinned
 * instead is the decision structure: who gets asked first, what counts as a
 * failure, and what a proxy changes. */

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
          // A host the script does not name is unreachable. Answering it with a
          // bland success would let the rest of the pool quietly satisfy tests
          // whose premise is that something failed.
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

/**
 * A Net that knows one thing: whether this machine has a proxy.
 *
 * That is the entire interface this module uses. Nothing here ranks endpoints
 * or measures paths — the pool order is the module's own decision, so a test of
 * it must not be able to depend on Net at all.
 */
function scriptedNet(proxyUrl?: string) {
  const asks = Ref.makeUnsafe(0)
  const layer = Layer.succeed(
    GeoNet.Service,
    GeoNet.Service.of({
      register: () => Effect.void,
      registerGroup: () => Effect.void,
      status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
      watch: () => Effect.succeed({ state: "idle" }) as never,
      route: () => Effect.succeed(undefined),
      ranking: () => Effect.succeed([]),
      invalidateRanking: () => Effect.void,
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
        // The tiers rest on what these services ARE. The reference deployment
        // is the one the project stands behind; a mirror is donated hardware
        // that may lag or serve a regional extract, and when it is wrong the
        // caller cannot tell. So mirrors are a fallback and are ordered like one.
        const hosts = OsmClient.OVERPASS_ENDPOINTS.map((endpoint) => new URL(endpoint).hostname)
        expect(hosts.slice(0, 3)).toEqual([OFFICIAL, BACKUP_ONE, BACKUP_TWO])
        expect(hosts.slice(3).length).toBeGreaterThan(2)
      }),
    )

    it.effect("holds only full-planet instances", () =>
      Effect.sync(() => {
        // A region-limited instance answers successfully with data that
        // silently excludes everything outside its region — worse than an
        // error, because nothing about the response says so (§6.3).
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
        // A busy instance answers 200 with HTML, so parseability is a failover
        // criterion in its own right — a status check alone calls this success.
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
        // The data that did arrive is usable, so the endpoint keeps its place.
        // What must not happen is calling it a clean success (§6.3 第四种失败).
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
        // Another endpoint would produce the same enormous answer; only the
        // caller asking for less can fix it.
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
        // Cancellation says nothing about the endpoint's health.
        expect(yield* Ref.get(http.asked)).toEqual([OFFICIAL])
      }),
    )
  }

  {
    // Tier one is entirely down; the mirrors are what is left.
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
            // Not "everything failed" — which host, over which route, with
            // what answer. That is what makes a bad round diagnosable.
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
    // The geocoder is a single endpoint with two attempts, so it reaches the
    // same "everything failed" state far more cheaply than the pool does.
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

          // Total failure is the one moment the proxy answer might have gone
          // stale — one started, stopped, or moved while the session ran. Any
          // other time, re-asking would be loopback connections for nothing.
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
        // The official instance leads a fresh process, but once it has been
        // shown to be down, paying its timeout on every subsequent call is
        // waste the caller can feel (§6.3 粘性端点).
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
        // A machine's proxy situation does not change between two requests a
        // second apart, and asking costs loopback connections each time.
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
        // The shape a search takes: both engines are asked in parallel, and on
        // the first one of a session neither has an answer to reuse yet.
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
        // One decision for all of OSM: these are ordinary public hosts, and a
        // network that needs a proxy to reach one needs it to reach the rest.
        expect(yield* Ref.get(http.routes)).toEqual(["proxy", "proxy", "proxy"])
      }),
    )
  }
})
