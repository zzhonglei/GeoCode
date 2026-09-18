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

/* The four capabilities (docs/GEOKERNEL.md §6.8): degradations stay visible instead of arriving looking like a clean
 * answer. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-osm-svc-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

type Reply = { readonly status: number; readonly body: string } | { readonly error: Error }

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
        const both = candidate({ id: 1, sources: new Set(["geocoder", "features"]) })
        const one = candidate({ id: 2 })
        expect(OsmSearch.score(both)).toBeGreaterThan(OsmSearch.score(one))

        // Importance outweighs the dual-source bonus, or a famous mountain loses to an obscure hill that shares
        // its name and happened to match twice.
        const famous = candidate({ id: 3, importance: 0.6 })
        expect(OsmSearch.score(famous)).toBeGreaterThan(OsmSearch.score(both))

        expect(OsmSearch.score(candidate({ id: 4, type: "relation" }))).toBeGreaterThan(
          OsmSearch.score(candidate({ id: 5, type: "way" })),
        )

        // And a transport stop is pushed below a bare node even as a relation: one landmark has many of them.
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
        expect(merged.name).toBe("武大")
        expect(merged.importance).toBe(0.5)
        expect([...merged.sources].sort()).toEqual(["features", "geocoder"])
        // `transit` is ANDed rather than kept: it is a guess from tags, and one engine not making it is enough.
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
        expect(result.candidates).toHaveLength(1)
        expect(result.notes.some((note) => note.includes("geocoder"))).toBe(true)
        // Which the merged candidates cannot show: a zero beside a full list is only visible per engine.
        expect(result.engines).toEqual({ geocoder: 0, features: 1 })
      }),
    )
  }

  {
    // Keyed off the query itself and not off a call counter: the client tours the endpoint pool and retries, so a
    // counter would let the "the category query fails" premise succeed on a later attempt.
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
          // The note is the point: the retry filters on the KEY alone, so a `k=v` category comes back wider.
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
        // A normal status and a well-formed body whose numbers are simply short (§6.3), carrying the service's own
        // words: "timed out" and "too broad to run" ask opposite things of the caller.
        expect(result.incomplete).toEqual([{ extent: "bbox:30,114,31,115", remark: "runtime error: Query timed out" }])

        // A distribution goes the same way, where saying nothing presents a partial vocabulary as the complete one.
        const spread = yield* osm.distribution({ extents: ["bbox:30,114,31,115"], key: "amenity" })
        expect(spread.incomplete.map((entry) => entry.extent)).toEqual(["bbox:30,114,31,115"])
      }),
    )
  }

  {
    // Over the vertex budget in extent.ts, so the extent degrades to its convex hull, a superset (§6.4).
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
        // A count is never narrowed back the way a download is, so the number is the hull's and only the flag says so.
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
        // Calling this truncated would send the caller subdividing an area that needs no subdividing.
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
    // Three extents, the middle one refused by the service.
    const http = scriptedHttp((_url, body) =>
      decodeURIComponent(body ?? "").includes("114.9") ? { error: new Error("connect ETIMEDOUT") } : json(elements),
    )
    const it = graph(http.layer)

    it.live("progress counts every extent that settles, failures included, and opens before the first one", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const ticks: [number, number][] = []
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:30,114,31,114.5", "bbox:30,114.9,31,115", "bbox:30,115.5,31,116"],
          tags: ["amenity"],
          output: path.join(root, "progress", "out.geojson"),
          onProgress: (settled, total) => Effect.sync(() => void ticks.push([settled, total])),
        })

        // Without the opening tick, a download of one extent reports nothing until it is already over.
        expect(ticks[0]).toEqual([0, 3])
        expect(ticks).toEqual([
          [0, 3],
          [1, 3],
          [2, 3],
          [3, 3],
        ])

        // A run whose extents are timing out is the one that takes longest, and the one that must not look frozen.
        expect(result.failed).toHaveLength(1)
        expect(result.extentsDone).toBe(2)
        // Which is why `settled` and `extentsDone` are two words: here they disagree, and both are right.
        expect(ticks.at(-1)![0]).not.toBe(result.extentsDone)
      }),
    )

    it.live("an extent that never parsed is settled before the first request goes out", () =>
      Effect.gen(function* () {
        // The only case here with `failed` non-empty before the loop, so the only one where seeding `settled` from
        // zero shows: it would open at 0/2 and finish at 1/2.
        const osm = yield* GeoOsm.Service
        const ticks: [number, number][] = []
        const result = yield* osm.downloadFeatures({
          extents: ["bbox:this is not an extent", "bbox:30,114,31,114.5"],
          tags: ["amenity"],
          output: path.join(root, "unparseable", "out.geojson"),
          onProgress: (settled, total) => Effect.sync(() => void ticks.push([settled, total])),
        })

        expect(ticks[0]).toEqual([1, 2])
        expect(ticks.at(-1)).toEqual([2, 2])
        expect(result.failed).toHaveLength(1)
        expect(result.extentsDone).toBe(1)
      }),
    )
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

    it.live("a write that cannot happen comes back as a failure, not a defect", () =>
      Effect.gen(function* () {
        // `OsmOutput.write` throws on a full disk or an unwritable path, which inside `Effect.gen` would be a defect
        // past `Effect.result`; a parent that is a file forces the throw.
        const blocker = path.join(root, "blocker")
        fs.writeFileSync(blocker, "not a directory")
        const osm = yield* GeoOsm.Service
        const outcome = yield* Effect.result(
          osm.downloadFeatures({
            extents: ["bbox:30,114,31,115"],
            tags: ["amenity"],
            output: path.join(blocker, "out.geojson"),
          }),
        )
        expect(outcome._tag).toBe("Failure")
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
        // How much of the answer asking for `node` alone would have missed (§6.8).
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
        // Below the floor an ordinary query comes back over budget, and a partial answer reads to the caller as
        // "there is nothing here" (§6.3).
        expect((yield* Ref.get(http.sent)).at(-1)).toContain("[timeout:30]")
      }),
    )
  }

  {
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

    // A failing extent tours the whole endpoint pool with backoff before giving up, hence the raised timeout.
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

          // Same download, network gone (§6.7).
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

        const firstPaths = first.outputs.map((entry) => entry.path)
        const secondPaths = second.outputs.map((entry) => entry.path)
        expect(secondPaths).not.toEqual(firstPaths)
        for (const written of [...firstPaths, ...secondPaths]) expect(fs.existsSync(written)).toBe(true)
        expect(second.features).toBe(first.features)
        // Numbered on the base and before the split, so one run's files all carry the same number (geo/naming.ts).
        expect(secondPaths.every((entry) => entry.includes("roads (1)"))).toBe(true)
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
        // Both extents answer with the same two elements, and the count removed is the only thing left saying
        // they overlapped.
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
        if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("tag filter")
        expect(yield* Ref.get(http.sent)).toHaveLength(0)
      }),
    )
  }

  {
    // A 200 with a note that the budget ran out, which means the element set behind it is short.
    const http = scriptedHttp(() => json({ ...elements, remark: "runtime error: Query timed out" }))
    const it = graph(http.layer)

    it.live("a batched fetch cut short by the server says so", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadObjects({
          ids: ["W2"],
          output: path.join(root, "truncated.geojson"),
        })
        // The dropped objects fall through to the per-object fallback, which goes partial on large relations, so
        // without this note the caller reads its troubles as a problem with the objects.
        expect(result.incomplete).toEqual([{ extent: "the batched fetch", remark: "runtime error: Query timed out" }])
        expect(result.features).toBe(1)
      }),
    )
  }

  {
    // The batched query answers for the way and the OSM API for the node, so one of the two ids is settled before
    // the per-object fallback runs at all.
    const http = scriptedHttp((url) =>
      url.includes("openstreetmap.org/api")
        ? json({ elements: [elements.elements[0]] })
        : json({ elements: [elements.elements[1]] }),
    )
    const it = graph(http.layer)

    it.live("progress picks up where the batched fetch left off", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const ticks: [number, number][] = []
        const result = yield* osm.downloadObjects({
          ids: ["N1", "W2"],
          output: path.join(root, "objprogress", "out.geojson"),
          onProgress: (settled, total) => Effect.sync(() => void ticks.push([settled, total])),
        })
        // "1 of 2" first, not "0 of 2": the fallback is the slow half and it starts with work already done, so a
        // counter of its own would report a step backwards after the batch.
        expect(ticks).toEqual([
          [1, 2],
          [2, 2],
        ])
        expect(result.features).toBe(2)
      }),
    )

    it.live("an id that never parsed is counted in the denominator, the way the result counts it", () =>
      Effect.gen(function* () {
        // The live channel and the final metadata publish this under one name, `objects_asked`
        // (tool/geo-osm-objects.ts), so counting only the parseable ids here gives that name two meanings.
        const osm = yield* GeoOsm.Service
        const ticks: [number, number][] = []
        const result = yield* osm.downloadObjects({
          ids: ["W2", "not-an-id"],
          output: path.join(root, "objdenominator", "out.geojson"),
          onProgress: (settled, total) => Effect.sync(() => void ticks.push([settled, total])),
        })
        expect(ticks.at(-1)).toEqual([2, 2])
        expect(result.extentsAsked).toBe(2)
        for (const [, total] of ticks) expect(total).toBe(result.extentsAsked)
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
        // The query builders throw on malformed input, which inside `Effect.gen` would be a defect every caller misses.
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

        // Whole-call mistakes, so nothing is asked of anyone: unlike one bad extent there is nothing to salvage.
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

describe("a widened boundary is narrowed back before anything is counted", () => {
  // The assertions read the file back: a report agreeing with the number it was handed proves nothing.

  // 400 vertices with deep notches: over the budget, and a convex hull covering far more than the star itself.
  const star: [number, number][] = []
  for (let i = 0; i < 400; i++) {
    const t = (i / 400) * Math.PI * 2
    const r = i % 2 === 0 ? 0.1 : 0.03
    star.push([114.3 + r * Math.cos(t), 30.5 + r * Math.sin(t)])
  }
  star.push(star[0]!)
  const boundaryFile = path.join(root, "star.geojson")
  fs.writeFileSync(
    boundaryFile,
    JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [star] } }),
  )

  // One at the centre, inside the star; one 0.07 out along a notch, inside the hull the query was widened to and
  // outside the boundary that was asked for.
  const notch = (1 / 400) * Math.PI * 2
  const elements = {
    elements: [
      { type: "node", id: 1, tags: { amenity: "cafe" }, lat: 30.5, lon: 114.3 },
      {
        type: "node",
        id: 2,
        tags: { amenity: "cafe" },
        lat: 30.5 + 0.07 * Math.sin(notch),
        lon: 114.3 + 0.07 * Math.cos(notch),
      },
    ],
  }

  const http = scriptedHttp(() => json(elements))
  const it = graph(http.layer)

  it.live("the count, the bytes and the geometry tally all describe the file on disk", () =>
    Effect.gen(function* () {
      const osm = yield* GeoOsm.Service
      const output = path.join(root, "narrowed.geojson")
      const result = yield* osm.downloadFeatures({
        extents: [`file:${boundaryFile}`],
        tags: ["amenity"],
        output,
      })

      // The query really was widened, without which none of this proves anything.
      const sent = yield* Ref.get(http.sent)
      expect(sent[0]).toContain("poly")
      expect(result.features).toBe(1)

      const written = JSON.parse(fs.readFileSync(result.outputs[0]!.path, "utf-8"))
      expect(written.features).toHaveLength(result.features)
      // The survivor is the one in the star, not the one in the notch.
      expect(written.features[0].geometry.coordinates).toEqual([114.3, 30.5])
      expect(result.outputs[0]!.count).toBe(written.features.length)
      expect(result.bytes).toBe(fs.statSync(result.outputs[0]!.path).size)
      expect(result.geometry).toEqual({ Point: written.features.length })

      // And `exact` is cleared back, because after the narrowing the result really is the boundary's.
      expect(result.exact).toBe(true)
    }),
  )

  {
    // Its midpoint is outside the boundary, so filtering after the collapse would drop it silently.
    const road = {
      elements: [
        {
          type: "way",
          id: 3,
          tags: { amenity: "cafe" },
          geometry: [
            { lat: 30.5, lon: 114.3 }, // the centre of the star
            { lat: 31.0, lon: 114.3 }, // five times the star's radius away
          ],
        },
      ],
    }
    const roadHttp = scriptedHttp(() => json(road))
    const roadIt = graph(roadHttp.layer)

    roadIt.live("a road reaching in survives centroid mode, though its midpoint is outside", () =>
      Effect.gen(function* () {
        const osm = yield* GeoOsm.Service
        const result = yield* osm.downloadFeatures({
          extents: [`file:${boundaryFile}`],
          tags: ["amenity"],
          output: path.join(root, "centroid-order.geojson"),
          geometry: "centroid",
        })
        expect(result.features).toBe(1)
        expect(result.centroidConverted).toBe(1)
        const written = JSON.parse(fs.readFileSync(result.outputs[0]!.path, "utf-8"))
        // Written at a midpoint outside the boundary, which is what shows the filter ran before the collapse.
        expect(written.features[0].geometry.coordinates[1]).toBeGreaterThan(30.6)
      }),
    )
  }
})
