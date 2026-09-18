import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OsmCentroid } from "@/geo/osm/centroid"
import { OsmConvert } from "@/geo/osm/convert"
import { OsmOutput } from "@/geo/osm/output"
import { OsmQuery } from "@/geo/osm/query"

/* Conversion, normalization and output (docs/GEOKERNEL.md §6.6–§6.8). */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-osm-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A closed square way, in the shape Overpass `out geom` produces. */
const square = (id: number, tags: Record<string, string>, x = 0, y = 0) => ({
  type: "way",
  id,
  tags,
  geometry: [
    { lat: y, lon: x },
    { lat: y, lon: x + 1 },
    { lat: y + 1, lon: x + 1 },
    { lat: y + 1, lon: x },
    { lat: y, lon: x },
  ],
})

describe("osm conversion isolation", () => {
  test("a relation cannot swallow a member that was matched in its own right", () => {
    // Silently, in the batch form: nothing reports a feature that was never built.
    const member = square(11, { building: "yes", name: "block" })
    const relation = {
      type: "relation",
      id: 22,
      tags: { type: "multipolygon", landuse: "residential", name: "estate" },
      members: [{ type: "way", ref: 11, role: "outer", geometry: member.geometry }],
    }
    const raw = { elements: [member, relation] }
    const policy = OsmConvert.fieldPolicy([])

    const batch = OsmConvert.convertBatch(raw, policy)
    const isolated = OsmConvert.convertElements(raw, policy)

    expect(isolated.features.map((f) => f.properties.osm_id).sort()).toEqual([11, 22])
    expect(batch.features.length).toBeLessThan(isolated.features.length)
    expect(OsmConvert.pick(isolated.features, { type: "way", id: 11 })).toBeDefined()
    expect(OsmConvert.pick(isolated.features, { type: "relation", id: 22 })).toBeDefined()
  })

  test("an element that will not assemble is named, not dropped in silence", () => {
    const broken = { type: "way", id: 99, tags: { building: "yes" }, geometry: [] }
    const converted = OsmConvert.convertElements({ elements: [broken] }, OsmConvert.fieldPolicy([]))
    expect(converted.features).toHaveLength(0)
    expect(converted.unassembled).toEqual(["W99"])
  })

  test("untagged elements are not features", () => {
    // An untagged way is the vertices of something else; emitting it as a feature buries the real matches.
    const converted = OsmConvert.convertElements(
      { elements: [square(1, {}), square(2, { amenity: "school" }, 5)] },
      OsmConvert.fieldPolicy([]),
    )
    expect(converted.features.map((f) => f.properties.osm_id)).toEqual([2])
  })
})

describe("osm field contract", () => {
  const tags = {
    name: "第一医院",
    amenity: "hospital",
    emergency: "yes",
    "addr:street": "解放大道",
    "name:en": "First Hospital",
    operator: "市卫健委",
  }

  test("core columns are always there, and the category is one string", () => {
    const { properties } = OsmConvert.buildProperties("way", 7, tags, OsmConvert.fieldPolicy([]))
    expect(properties.osm_id).toBe(7)
    expect(properties.osm_type).toBe("way")
    expect(properties.name).toBe("第一医院")
    expect(properties.category).toBe("amenity=hospital")
    for (const field of OsmConvert.CORE_FIELDS) expect(field in properties).toBe(true)
  })

  test("what the query asked by is kept, the rest is dropped but counted", () => {
    const policy = OsmConvert.fieldPolicy(["amenity=hospital", "emergency"])
    const { properties, dropped } = OsmConvert.buildProperties("way", 7, tags, policy)
    expect(properties.emergency).toBe("yes")
    // By key, so the caller can ask again naming exactly what it lost (§6.6).
    expect(dropped.sort()).toEqual(["addr:street", "name:en", "operator"])
    expect(properties["addr:street"]).toBeUndefined()
  })

  test("named fields are kept, and a star keeps everything losslessly", () => {
    const named = OsmConvert.fieldPolicy([], ["operator"])
    expect(OsmConvert.buildProperties("way", 7, tags, named).properties.operator).toBe("市卫健委")

    const all = OsmConvert.buildProperties("way", 7, tags, OsmConvert.fieldPolicy([], ["*"]))
    expect(all.dropped).toEqual([])
    expect(JSON.parse(all.properties.osm_tags as string)).toEqual(tags)
  })

  test("the library's own metadata never becomes a field", () => {
    // The conversion library mixes its own `id` and `bounds` into properties; kept, they read as tags a caller
    // could filter on.
    const converted = OsmConvert.convertElements(
      { elements: [square(3, { amenity: "cafe" })] },
      OsmConvert.fieldPolicy([], ["*"]),
    )
    const stored = JSON.parse(converted.features[0]!.properties.osm_tags as string)
    expect(stored.id).toBeUndefined()
    expect(stored.bounds).toBeUndefined()
    expect(stored.amenity).toBe("cafe")
  })

  test("the tally reads commonest first", () => {
    const tally = new Map([
      ["surface", 3],
      ["operator", 12],
      ["ref", 7],
    ])
    expect(OsmConvert.formatDroppedFields(tally)).toEqual(["operator(12)", "ref(7)", "surface(3)"])
    expect(OsmConvert.formatDroppedFields(tally, 1)).toEqual(["operator(12)"])
  })
})

describe("osm assembly verification", () => {
  const ring = (n: number) => ({
    type: "Polygon",
    coordinates: [Array.from({ length: n }, (_, i) => [i / n, i / n])],
  })

  test("a boundary assembled from a fraction of its nodes is refused", () => {
    // A partial boundary is still a boundary, so every area and clip taken from it is wrong and nothing says so.
    expect(OsmConvert.assemblyLooksComplete(ring(182), 4613)).toBe(false)
    expect(OsmConvert.assemblyLooksComplete(ring(4600), 4613)).toBe(true)
  })

  test("small objects are exempt, because ring closure skews the ratio", () => {
    expect(OsmConvert.assemblyLooksComplete(ring(4), 10)).toBe(true)
  })
})

describe("osm feature bookkeeping", () => {
  const feature = (type: string, id: number, geometryType = "Point") => ({
    type: "Feature" as const,
    properties: { osm_type: type, osm_id: id },
    geometry: { type: geometryType, coordinates: [0, 0] },
  })

  test("the same object arriving from two extents is kept once", () => {
    const deduped = OsmConvert.dedupe([feature("way", 1), feature("way", 1), feature("node", 1)])
    // Identity is type AND id: a way and a node can share a number.
    expect(deduped).toHaveLength(2)
  })

  test("families group single and multi variants together", () => {
    expect(OsmConvert.family("Point")).toBe("points")
    expect(OsmConvert.family("MultiPoint")).toBe("points")
    expect(OsmConvert.family("LineString")).toBe("lines")
    expect(OsmConvert.family("MultiPolygon")).toBe("polygons")
    const groups = OsmConvert.splitByFamily([
      feature("node", 1, "Point"),
      feature("way", 2, "LineString"),
      feature("way", 3, "MultiLineString"),
    ])
    expect([...groups.keys()].sort()).toEqual(["lines", "points"])
    expect(groups.get("lines")).toHaveLength(2)
  })
})

describe("osm representative points", () => {
  test("a polygon collapses to its area-weighted centre", () => {
    const point = OsmCentroid.ringCentroid([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ])
    expect(point[0]).toBeCloseTo(1)
    expect(point[1]).toBeCloseTo(1)
  })

  test("a small ring far from the origin still resolves inside itself", () => {
    // Small and far from the origin, where cross products taken on raw coordinates cancel enough significant digits
    // to put the answer outside the ring's own bounding box.
    const ring: [number, number][] = [
      [114.3604117, 30.5337849],
      [114.3603763, 30.5336521],
      [114.3607236, 30.5335836],
      [114.3607338, 30.5336211],
      [114.3607588, 30.5337166],
      [114.3604117, 30.5337849],
    ]
    const [x, y] = OsmCentroid.ringCentroid(ring)
    const xs = ring.map((p) => p[0])
    const ys = ring.map((p) => p[1])
    expect(x).toBeGreaterThanOrEqual(Math.min(...xs))
    expect(x).toBeLessThanOrEqual(Math.max(...xs))
    expect(y).toBeGreaterThanOrEqual(Math.min(...ys))
    expect(y).toBeLessThanOrEqual(Math.max(...ys))
  })

  test("a line collapses to its midpoint by distance, not by vertex", () => {
    // Three of the four vertices bunched at one end, so halfway through the list is nowhere near halfway along.
    const point = OsmCentroid.lineMidpoint([
      [0, 0],
      [0.1, 0],
      [0.2, 0],
      [10, 0],
    ])
    expect(point[0]).toBeCloseTo(5)
  })

  test("a multi-part area answers from its largest part", () => {
    const { features } = OsmCentroid.normalize([
      {
        type: "Feature",
        properties: { osm_type: "relation", osm_id: 1 },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [0, 0],
                [0.1, 0],
                [0.1, 0.1],
                [0, 0.1],
                [0, 0],
              ],
            ],
            [
              [
                [10, 10],
                [14, 10],
                [14, 14],
                [10, 14],
                [10, 10],
              ],
            ],
          ],
        },
      },
    ])
    // The larger part is the second one; taking the first would be a country's point on an offshore island.
    expect(features[0]!.geometry.coordinates[0]).toBeCloseTo(12)
  })

  test("what a point used to be is recorded, and points pass through untouched", () => {
    const original = {
      type: "Feature" as const,
      properties: { osm_type: "node", osm_id: 5, name: "kiosk" },
      geometry: { type: "Point", coordinates: [1, 2] },
    }
    const area = {
      type: "Feature" as const,
      properties: { osm_type: "way", osm_id: 6, name: "campus" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
        ],
      },
    }
    const { features, dropped } = OsmCentroid.normalize([original, area])
    expect(dropped).toEqual([])
    // `toBe`: an already-point feature is the same object, so `original_geometry` marks exactly the converted ones.
    expect(features[0]).toBe(original)
    expect(features[1]!.properties.original_geometry).toBe("Polygon")
    expect(features[1]!.properties.name).toBe("campus")
    expect(features[1]!.geometry.type).toBe("Point")
  })

  test("a feature with no reducible geometry is reported in a shape that can be re-fetched", () => {
    const { features, dropped } = OsmCentroid.normalize([
      { type: "Feature", properties: { osm_type: "way", osm_id: 9 }, geometry: null },
    ])
    expect(features).toEqual([])
    // The caller is told to fetch it by this name, and only `parseRef` can say the spelling is one it accepts.
    expect(dropped).toEqual(["W9"])
    expect(OsmQuery.parseRef(dropped[0]!)).toEqual({ type: "way", id: 9 })
  })

  test("a ring with no vertices is a loss, not a pair of nulls", () => {
    // An empty ring answers `[NaN, NaN]`, which is an array and therefore truthy, and `JSON.stringify` writes it
    // as `[null, null]`: invalid GeoJSON on the user's disk with nothing in the loss list to say so.
    const { features, dropped } = OsmCentroid.normalize([
      {
        type: "Feature",
        properties: { osm_type: "way", osm_id: 11 },
        geometry: { type: "Polygon", coordinates: [[]] },
      } as never,
    ])
    expect(features).toEqual([])
    expect(dropped).toEqual(["W11"])
  })
})

describe("osm output files", () => {
  const feature = (id: number, geometryType: string) => ({
    type: "Feature" as const,
    properties: { osm_type: "way", osm_id: id },
    geometry: {
      type: geometryType,
      coordinates:
        geometryType === "Point"
          ? [0, 0]
          : [
              [0, 0],
              [1, 1],
            ],
    },
  })

  test("one family writes one file", () => {
    const base = path.join(root, "single", "out.geojson")
    const { outputs } = OsmOutput.write(base, [feature(1, "Point"), feature(2, "Point")])
    expect(outputs).toEqual([{ path: base, count: 2, family: "points" }])
    expect(JSON.parse(fs.readFileSync(base, "utf-8")).features).toHaveLength(2)
  })

  test("several families are split, and the mixed file is never written", () => {
    const base = path.join(root, "mixed", "out.geojson")
    const { outputs } = OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(outputs.map((o) => o.family).sort()).toEqual(["lines", "points"])
    expect(fs.existsSync(base)).toBe(false)
    expect(fs.existsSync(base.replace(".geojson", "-points.geojson"))).toBe(true)
  })

  test("a re-run writes beside the last one, both ways round", () => {
    const base = path.join(root, "rerun", "out.geojson")
    const points = base.replace(".geojson", "-points.geojson")
    const lines = base.replace(".geojson", "-lines.geojson")

    OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(fs.existsSync(points) && fs.existsSync(lines)).toBe(true)

    // Then a run producing only points, which still takes the next number (`taken` in output.ts).
    const second = OsmOutput.write(base, [feature(1, "Point")])
    expect(second.outputs[0]!.path).toBe(path.join(root, "rerun", "out (1).geojson"))
    expect(fs.existsSync(points) && fs.existsSync(lines)).toBe(true)

    // And back the other way: a splitting run after an unsplit one.
    const third = OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(third.outputs.map((o) => o.path).sort()).toEqual([
      path.join(root, "rerun", "out (2)-lines.geojson"),
      path.join(root, "rerun", "out (2)-points.geojson"),
    ])
    expect(fs.existsSync(path.join(root, "rerun", "out (1).geojson"))).toBe(true)
  })

  test("an empty list still produces a file rather than throwing", () => {
    // Unreachable through the service, which stops at zero features in `writeIfAny`; this covers a direct call.
    const base = path.join(root, "empty", "out.geojson")
    const { outputs } = OsmOutput.write(base, [])
    expect(outputs[0]!.family).toBe("empty")
    expect(JSON.parse(fs.readFileSync(base, "utf-8")).features).toEqual([])
  })

  test("a base that is not named .geojson still gets three distinct files", () => {
    // A sibling name derived by rewriting a ".geojson" suffix comes back equal to this base, and every family then
    // overwrites the same file.
    const base = path.join(root, "ext", "out.json")
    const { outputs } = OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(new Set(outputs.map((o) => o.path)).size).toBe(2)
    for (const output of outputs) expect(fs.existsSync(output.path)).toBe(true)
    expect(outputs.every((o) => o.path !== base)).toBe(true)
  })

  test("a base with no extension is written as GeoJSON, because that is what it is", () => {
    const base = path.join(root, "bare", "out")
    const { outputs } = OsmOutput.write(base, [feature(1, "Point")])
    expect(outputs[0]!.path).toBe(`${base}.geojson`)
    expect(fs.existsSync(`${base}.geojson`)).toBe(true)
  })
})
