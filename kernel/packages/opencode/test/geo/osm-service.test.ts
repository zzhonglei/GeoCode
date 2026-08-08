import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoNet } from "@/geo/net"
import { GeoOsm } from "@/geo/osm"
import { OsmClient } from "@/geo/osm/client"
import { OsmHttp } from "@/geo/osm/http"
import { OsmSearch } from "@/geo/osm/search"
import type { NetTypes } from "@/geo/net/types"
import { testEffect } from "../lib/effect"

/* The four capabilities (docs/GEOKERNEL.md §6.8).
 *
 * The whole workflow ran against the live services — search, count,
 * distribution and both download modes over a real Wuhan bbox. What is pinned
 * here is what the caller is told: the facts a tool has to report, and the
 * degradations that must stay visible rather than looking like a clean
 * answer. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-osm-svc-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

type Reply = { readonly status: number; readonly body: string } | { readonly error: Error }

/** An HTTP layer answering by request shape, recording the bodies it was sent. */
function scriptedHttp(reply: (url: string, body: string | undefined) => Reply) {
  const sent = Ref.makeUnsafe<string[]>([])
  const layer = Layer.succeed(
    OsmHttp.Service,
    OsmHttp.Service.of({
      request: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sent, (all) => [...all, decodeURIComponent(input.body ?? "")])
          const answer = reply(input.url, input.body)
          if ("error" in answer) return yield* Effect.fail(answer.error as any)
          return { status: answer.status, body: answer.body }
        }),
    }),
  )
  return { layer, sent }
}

const netLayer = Layer.succeed(
  GeoNet.Service,
  GeoNet.Service.of({
    register: () => Effect.void,
    status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
    watch: () => Effect.succeed({ state: "idle" }) as never,
    route: () => Effect.succeed({ kind: "direct" } as NetTypes.Route),
    proxy: () => Effect.succeed(undefined),
  }),
)

const graph = (http: Layer.Layer<OsmHttp.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([GeoOsm.node]), [
      [OsmHttp.node, http],
      [GeoNet.node, netLayer],
    ]),
  )

const json = (value: unknown) => ({ status: 200, body: JSON.stringify(value) })

describe("osm search ranking", () => {
  const candidate = (over: Partial<OsmSearch.Candidate>): OsmSearch.Candidate => ({
    type: "node",
    id: 1,
    sources: new Set(["features"]),
    transit: false,
    ...over,
  })

  it_ranking()
  function it_ranking() {
    const it = graph(scriptedHttp(() => json({})).layer)

    it.effect("the four signals order the candidates", () =>
      Effect.sync(() => {
        // Two engines agreeing is the strongest confidence there is…
        const both = candidate({ id: 1, sources: new Set(["geocoder", "features"]) })
        const one = candidate({ id: 2 })
        expect(OsmSearch.score(both)).toBeGreaterThan(OsmSearch.score(one))

        // …but importance outranks it, or a famous mountain loses to an
        // obscure hill that happens to share its name and matched twice.
        const famous = candidate({ id: 3, importance: 0.6 })
        expect(OsmSearch.score(famous)).toBeGreaterThan(OsmSearch.score(both))

        // Areas before lines before points.
        expect(OsmSearch.score(candidate({ id: 4, type: "relation" }))).toBeGreaterThan(
          OsmSearch.score(candidate({ id: 5, type: "way" })),
        )

        // And a transport stop sharing the name is pushed down hard: they are
        // almost always noise, and there are usually many of them.
        const stop = candidate({ id: 6, type: "relation", transit: true })
        expect(OsmSearch.score(stop)).toBeLessThan(OsmSearch.score(candidate({ id: 7 })))
      }),
    )

    it.effect("merging keeps what each engine knew", () =>
      Effect.sync(() => {
        const into = new Map<string, OsmSearch.Candidate>()
        OsmSearch.upsert(into, candidate({ id: 9, type: "relation", name: "武大", transit: true }))
        OsmSearch.upsert(
          into,
          candidate({ id: 9, type: "relation", sources: new Set(["geocoder"]), importance: 0.5, transit: false }),
        )
        const merged = into.get("relation/9")!
        // Facts merge; neither engine's blank overwrites the other's answer.
        expect(merged.name).toBe("武大")
        expect(merged.importance).toBe(0.5)
        expect([...merged.sources].sort()).toEqual(["features", "geocoder"])
        // One engine calling it a real place is enough to stop treating it as a stop.
        expect(merged.transit).toBe(false)
      }),
    )
  }
})

describe("osm search degradation", () => {
  {
    // The geocoder is down; the literal engine still answers.
    const http = scriptedHttp((url) =>
      url.includes("nominatim")
        ? { error: new Error("connect ECONNREFUSED") }
        : json({ elements: [{ type: "relation", id: 5, tags: { name: "武汉大学", amenity: "university" } }] }),
    )
    const it = graph(http.layer)

    it.live("one engine failing is a note, not a failure", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.search({ query: "武汉大学" })
        // Their recall barely overlaps, so half an answer is still worth
        // having — as long as the caller is told it is half (§6.8).
        expect(result.candidates).toHaveLength(1)
        expect(result.notes.some((note) => note.includes("geocoder"))).toBe(true)
        // Zero from one engine beside a full list from the other is what makes
        // "half an answer" visible. It cannot be recovered from the merged
        // candidates, so the kernel reports it.
        expect(result.engines).toEqual({ geocoder: 0, features: 1 })
      }),
    )
  }

  {
    // A category-filtered global name search exhausts the server; the retry
    // drops the filter and applies it here instead.
    // Keyed off the query itself, not a call counter: the client retries a
    // failing endpoint across rounds, so a counter would let the "category
    // query fails" premise succeed on the second attempt.
    const http = scriptedHttp((url, body) => {
      if (url.includes("nominatim")) return json([])
      if (decodeURIComponent(body ?? "").includes('["amenity"="university"]')) {
        return { status: 504, body: "<html>timeout</html>" }
      }
      return json({
        elements: [
          { type: "relation", id: 1, tags: { name: "武汉大学", amenity: "university" } },
          { type: "node", id: 2, tags: { name: "武汉大学站", railway: "station" } },
        ],
      })
    })
    const it = graph(http.layer)

    it.live(
      "a category that the server cannot afford is applied here instead",
      () =>
        Effect.gen(function* () {
          const osm = yield* GeoOsm.Service
          const result = yield* osm.search({ query: "武汉大学", category: "amenity=university" })
          // Only the element carrying the category survives, and the caller is
          // told the filtering moved (§6.8 降级路径).
          expect(result.candidates.map((c) => c.id)).toEqual([1])
          expect(result.notes.some((note) => note.includes("category"))).toBe(true)
        }),
      { timeout: 30000 },
    )
  }
})

describe("osm reconnaissance", () => {
  {
    const http = scriptedHttp(() =>
      json({ elements: [{ type: "count", id: 0, tags: { nodes: "120", ways: "40", relations: "3", total: "163" } }] }),
    )
    const it = graph(http.layer)

    it.live("counting reports the per-type split, not just a total", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.count({ extents: ["bbox:30,114,31,115"], tags: ["amenity"] })
        // A hundred thousand nodes and a hundred relations call for different
        // decisions, and the response carries both for free.
        expect(result.totals).toEqual({ nodes: 120, ways: 40, relations: 3, total: 163 })
        expect(result.perExtent[0]!.relations).toBe(3)
      }),
    )
  }

  {
    const http = scriptedHttp(() =>
      json({
        elements: [
          { type: "node", id: 1, tags: { amenity: "cafe" } },
          { type: "node", id: 2, tags: { amenity: "cafe" } },
          { type: "way", id: 3, tags: { amenity: "school" } },
        ],
      }),
    )
    const it = graph(http.layer)

    it.live("a distribution is ordered by frequency and counts its distinct values", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.distribution({ extents: ["bbox:30,114,31,115"], key: "amenity" })
        expect(result.values).toEqual([
          { value: "cafe", count: 2 },
          { value: "school", count: 1 },
        ])
        expect(result.distinct).toBe(2)
        expect(result.truncated).toBe(false)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json({ elements: [], remark: "runtime error: Query timed out" }))
    const it = graph(http.layer)

    it.live("an incomplete answer is named as incomplete", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.count({ extents: ["bbox:30,114,31,115"], tags: ["amenity"] })
        // The most dangerous of the four failure shapes: a normal response
        // whose numbers are simply short. Reported, never passed off as clean —
        // and carrying the service's own words, because "timed out" and "too
        // broad to run" call for opposite responses from the caller.
        expect(result.incomplete).toEqual([{ extent: "bbox:30,114,31,115", remark: "runtime error: Query timed out" }])

        // And a distribution can time out the same way. Reporting the values it
        // did see without saying the scan was cut short presents a partial
        // vocabulary as the complete one (§6.3).
        const spread = yield* osm.distribution({ extents: ["bbox:30,114,31,115"], key: "amenity" })
        expect(spread.incomplete.map((entry) => entry.extent)).toEqual(["bbox:30,114,31,115"])
      }),
    )
  }

  {
    // A boundary too detailed to send as-is, so the extent degrades to its
    // convex hull — a superset (§6.4).
    const boundary = path.join(root, "detailed.geojson")
    const ring = Array.from({ length: 600 }, (_, i) => {
      const angle = (i / 600) * Math.PI * 2
      // A comb, so the hull is genuinely larger than the ring it replaces.
      const radius = i % 2 === 0 ? 0.2 : 0.1
      return [114 + radius * Math.cos(angle), 30 + radius * Math.sin(angle)]
    })
    ring.push(ring[0]!)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(boundary, JSON.stringify({ type: "Polygon", coordinates: [ring] }))

    const http = scriptedHttp(() =>
      json({ elements: [{ type: "count", id: 0, tags: { nodes: "10", ways: "2", relations: "0", total: "12" } }] }),
    )
    const it = graph(http.layer)

    it.live("a count over an approximated boundary says so", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.count({ extents: [`file:${boundary}`], tags: ["amenity"] })
        // The count is of the hull, not of the boundary. A caller sizing a
        // download on it is sizing it on the wrong number, and only this flag
        // says so — the total looks like any other total.
        expect(result.totals.total).toBe(12)
        expect(result.exact).toBe(false)
      }),
    )
  }

  {
    // Two extents, each answering with well under the per-query sample cap.
    const many = (count: number) => ({
      elements: Array.from({ length: count }, (_, i) => ({ type: "node", id: i + 1, tags: { amenity: "cafe" } })),
    })
    const http = scriptedHttp(() => json(many(6_000)))
    const it = graph(http.layer)

    it.live("truncation is a per-extent fact, not a sum across extents", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.distribution({
          extents: ["bbox:30,114,31,115", "bbox:31,114,32,115"],
          key: "amenity",
        })
        // The server applies the cap per query. Twelve thousand across two
        // complete answers is not a truncated distribution, and calling it one
        // would send the caller subdividing an area that needs no subdividing.
        expect(result.sampled).toBe(12_000)
        expect(result.truncated).toBe(false)
      }),
    )
  }
})

describe("osm download", () => {
  const elements = {
    elements: [
      { type: "node", id: 1, tags: { amenity: "cafe", name: "咖啡", cuisine: "coffee_shop" }, lat: 30.5, lon: 114.3 },
      {
        type: "way",
        id: 2,
        tags: { amenity: "library", name: "图书馆" },
        geometry: [
          { lat: 30.5, lon: 114.3 },
          { lat: 30.5, lon: 114.31 },
          { lat: 30.51, lon: 114.31 },
          { lat: 30.51, lon: 114.3 },
          { lat: 30.5, lon: 114.3 },
        ],
      },
    ],
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("a mixed result splits by family and reports both halves of the field contract", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115"],
          tags: ["amenity"],
          output: path.join(root, "mixed.geojson"),
        })
        expect(result.outputs.map((o) => o.family).sort()).toEqual(["points", "polygons"])
        expect(result.bytes).toBeGreaterThan(0)
        // Reporting only what was dropped tells half the story; the caller
        // also needs to know which columns it actually got.
        expect(result.keptFields).toContain("osm_id")
        expect(result.keptFields).toContain("amenity")
        expect(result.droppedFields).toContain("cuisine(1)")
        expect(result.extentsDone).toBe(1)
        expect(result.exact).toBe(true)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("centroid mode reports how many areas it collapsed", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115"],
          tags: ["amenity"],
          output: path.join(root, "poi.geojson"),
          geometry: "centroid",
        })
        expect(result.geometry).toEqual({ Point: 2 })
        // The number that shows what asking for point elements alone would
        // have missed — here half of it (§6.8).
        expect(result.centroidConverted).toBe(1)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("the server-side budget is the caller's to set, with a floor", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115"],
          tags: ["amenity"],
          output: path.join(root, "budget.geojson"),
          timeoutSec: 300,
        })
        expect((yield* Ref.get(http.sent)).at(-1)).toContain("[timeout:300]")

        yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115"],
          tags: ["amenity"],
          output: path.join(root, "budget2.geojson"),
          timeoutSec: 1,
        })
        // Below the floor an ordinary query comes back incomplete, which the
        // caller reads as "there is nothing here".
        expect((yield* Ref.get(http.sent)).at(-1)).toContain("[timeout:30]")
      }),
    )
  }

  {
    // Two extents, one of which cannot be parsed at all.
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("what was obtained is kept when part of the request fails", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115", "nonsense"],
          tags: ["amenity"],
          output: path.join(root, "partial.geojson"),
        })
        // On a multi-area download, partial results beat discarding
        // everything — as long as the shortfall is stated (§6.7).
        expect(result.features).toBe(2)
        expect(result.failed.map((f) => f.extent)).toEqual(["nonsense"])
        expect(result.extentsDone).toBe(1)
        expect(result.extentsAsked).toBe(2)
        expect(fs.existsSync(path.join(root, "partial-points.geojson"))).toBe(true)
      }),
    )
  }

  {
    const http = scriptedHttp((_url, body) =>
      (body ?? "").includes("31.5") ? { error: new Error("network is down") } : json(elements),
    )
    const it = graph(http.layer)

    // A failing extent tours the endpoint pool with backoff before giving up,
    // so this one genuinely takes several seconds.
    it.live(
      "a run that obtains nothing leaves the last good run on disk",
      () =>
        Effect.gen(function* () {
          const osm = yield* GeoOsm.Service
          const output = path.join(root, "keep", "out.geojson")

          const first = yield* osm.downloadFeatures({
            extents: ["bbox:30,114,31,115"],
            tags: ["amenity"],
            output,
          })
          expect(first.features).toBe(2)
          const points = path.join(root, "keep", "out-points.geojson")
          expect(fs.existsSync(points)).toBe(true)

          // Same download, network gone. An empty run creates no file at all:
          // there is nothing worth writing, and the earlier run's files are
          // not this run's to touch (§6.7 — nothing overwrites).
          const second = yield* osm.downloadFeatures({
            extents: ["bbox:31.5,114,32,115"],
            tags: ["amenity"],
            output,
          })
          expect(second.features).toBe(0)
          expect(second.outputs).toEqual([])
          expect(second.failed).toHaveLength(1)
          expect(fs.existsSync(points)).toBe(true)
          expect(JSON.parse(fs.readFileSync(points, "utf-8")).features).toHaveLength(1)
        }),
      { timeout: 30000 },
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("a second download to the same path is numbered, not written over the first", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const output = path.join(root, "again", "roads.geojson")

        const first = yield* osm.downloadFeatures({ extents: ["bbox:30,114,31,115"], tags: ["amenity"], output })
        const second = yield* osm.downloadFeatures({ extents: ["bbox:30,114,31,115"], tags: ["amenity"], output })

        // Asking for the same path again is the ordinary case, not a mistake:
        // refreshing, recovering a dropped field, retrying a short result. It
        // costs minutes of somebody's time, so the earlier run stays.
        const firstPaths = first.outputs.map((entry) => entry.path)
        const secondPaths = second.outputs.map((entry) => entry.path)
        expect(secondPaths).not.toEqual(firstPaths)
        for (const written of [...firstPaths, ...secondPaths]) expect(fs.existsSync(written)).toBe(true)
        expect(second.features).toBe(first.features)
        // The number lands on the base, so a split run's files stay one run.
        expect(secondPaths.every((entry) => entry.includes("roads-1"))).toBe(true)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("the same object reached from two extents is counted once, and the overlap is reported", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,115", "bbox:30.5,114.5,31.5,115.5"],
          tags: ["amenity"],
          output: path.join(root, "overlap.geojson"),
        })
        // Both extents return the same two elements. Merged once — and the
        // number removed is what tells the caller the extents overlapped, which
        // is otherwise invisible in a deduplicated result.
        expect(result.features).toBe(2)
        expect(result.duplicates).toBe(2)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("a set of ids too large for a batched query is refused, with the alternative", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const outcome = yield* Effect.result(
          osm.downloadObjects({
            ids: Array.from({ length: 40 }, (_, i) => `R${i + 1}`),
            output: path.join(root, "many.geojson"),
          }),
        )
        expect(outcome._tag).toBe("Failure")
        // Refusing is only half of it: at this size the request wants a
        // different shape, and saying which one is the useful part.
        if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("tag filter")
        expect(yield* Ref.get(http.sent)).toHaveLength(0)
      }),
    )
  }

  {
    // The batched query answers 200 with a note that it ran out of budget —
    // which means the element set behind it is truncated.
    const http = scriptedHttp(() => json({ ...elements, remark: "runtime error: Query timed out" }))
    const it = graph(http.layer)

    it.live("a batched fetch cut short by the server says so", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadObjects({
          ids: ["W2"],
          output: path.join(root, "truncated.geojson"),
        })
        // A batch of large boundaries is the query that exhausts the server's
        // budget. The objects it dropped fall through to the per-object path,
        // which is the unreliable one — so without this the caller reads the
        // fallback's troubles as "those objects are a problem" (§6.3).
        expect(result.incomplete).toEqual([{ extent: "the batched fetch", remark: "runtime error: Query timed out" }])
        expect(result.features).toBe(1)
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("an id that never parsed still counts in what was asked for", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadObjects({
          ids: ["W2", "not-an-id"],
          output: path.join(root, "objects.geojson"),
        })
        // The unparsed id was never fetched, so it belongs in the denominator
        // and nowhere else. Subtracting it from the count of objects that were
        // fetched mixes two different totals.
        expect(result.extentsAsked).toBe(2)
        expect(result.extentsDone).toBe(1)
        expect(result.failed.map((f) => f.extent)).toEqual(["not-an-id"])
      }),
    )
  }

  {
    const http = scriptedHttp(() => json(elements))
    const it = graph(http.layer)

    it.live("a malformed type list or tag filter comes back as a failure, not a crash", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        // The query builders refuse malformed input by throwing, which is right
        // for pure functions — but a throw inside Effect.gen becomes a defect,
        // outside the error type every caller handles, and takes the caller
        // down instead of coming back as the sentence explaining what to write.
        const types = yield* Effect.result(
          osm.downloadFeatures({
            extents: ["bbox:30,114,31,115"],
            tags: ["amenity"],
            types: "banana",
            output: path.join(root, "bad.geojson"),
          }),
        )
        expect(types._tag).toBe("Failure")
        if (types._tag === "Failure") expect(types.failure.message).toContain("not a type list")

        const tags = yield* Effect.result(
          osm.downloadFeatures({
            extents: ["bbox:30,114,31,115"],
            tags: [""],
            output: path.join(root, "bad.geojson"),
          }),
        )
        expect(tags._tag).toBe("Failure")

        // Whole-call mistakes, so nothing was asked of anyone: unlike an
        // unparseable extent there is no partial result to salvage.
        expect(yield* Ref.get(http.sent)).toHaveLength(0)
      }),
    )

    it.live("too many extents is refused before any request goes out", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const outcome = yield* Effect.result(
          osm.downloadFeatures({
            extents: Array.from({ length: 20 }, (_, i) => `bbox:30,${114 + i / 100},31,115`),
            tags: ["amenity"],
            output: path.join(root, "flood.geojson"),
          }),
        )
        expect(outcome._tag).toBe("Failure")
        expect(yield* Ref.get(http.sent)).toHaveLength(0)
      }),
    )
  }
})
