import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OsmCentroid } from "@/geo/osm/centroid"
import { OsmConvert } from "@/geo/osm/convert"
import { OsmOutput } from "@/geo/osm/output"

/* Conversion, normalization and output (docs/GEOKERNEL.md §6.6–§6.8).
 *
 * The assembly itself ran against Wuhan's real boundary — 78 members and 4972
 * coordinates into a MultiPolygon of three parts with three holes, each hole
 * confirmed against OSM as another prefecture's territory. What is pinned here
 * is everything around that: which feature is the one asked for, what the
 * field set is, and the checks that keep a partial assembly from passing as a
 * whole one. */

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
    // The member way is tagged and would match a query on its own. Converted
    // as one batch, the relation consumes it and it never reaches the output —
    // silently, because nothing reports a feature that was never built.
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

    // Both elements survive isolation; the batch loses one of them.
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
    // Untagged ways are the vertices of something else, not objects in
    // themselves; emitting them would bury the real matches.
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
    // A "key=value" string rather than two columns: a bare `type` column would
    // collide with GeoJSON's own, and the pair is only read together (§6.6).
    expect(properties.category).toBe("amenity=hospital")
    for (const field of OsmConvert.CORE_FIELDS) expect(field in properties).toBe(true)
  })

  test("what the query asked by is kept, the rest is dropped but counted", () => {
    const policy = OsmConvert.fieldPolicy(["amenity=hospital", "emergency"])
    const { properties, dropped } = OsmConvert.buildProperties("way", 7, tags, policy)
    expect(properties.emergency).toBe("yes")
    // Dropping is not losing: the caller sees which keys went and can ask
    // again naming exactly those (§6.6 丢弃但按键计数上报).
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
    // `id` and `bounds` come from the element and the query, not the map.
    // Letting them in would present them as tags that could be filtered on.
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
    // The failure this exists for: a large relation stitches together from a
    // small part of what it was given and comes back as an ordinary-looking
    // polygon. Nothing downstream can tell — a partial boundary IS a boundary,
    // just the wrong one, and every area and clip taken from it is wrong too.
    expect(OsmConvert.assemblyLooksComplete(ring(182), 4613)).toBe(false)
    expect(OsmConvert.assemblyLooksComplete(ring(4600), 4613)).toBe(true)
  })

  test("small objects are exempt, because ring closure skews the ratio", () => {
    // A handful of nodes closing into rings can legitimately count either way;
    // the check is aimed at shortfalls big enough to mean whole segments went
    // missing, not at arithmetic noise.
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
    // A real 40 m car park in Wuhan, and the case that broke the previous
    // arithmetic: computed on raw coordinates, the cross products are
    // differences of products around 3500 that differ by about 0.01, five
    // significant digits cancel per term, and the answer landed 2 m OUTSIDE
    // the ring's own bounding box — which a centroid cannot do. The failure is
    // worst exactly where this is used most: small features, far from the
    // origin, which is what a city is made of.
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
    // Vertices bunch up around detail; halfway through the list is not
    // halfway along the line.
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
    // Otherwise a country's point lands on an offshore island.
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
    // A point that was already a point is the same object, unchanged.
    expect(features[0]).toBe(original)
    // A point that was a campus is a different fact, and says so — which is
    // what makes the normalization traceable rather than lossy (§6.8).
    expect(features[1]!.properties.original_geometry).toBe("Polygon")
    expect(features[1]!.properties.name).toBe("campus")
    expect(features[1]!.geometry.type).toBe("Point")
  })

  test("a feature with no reducible geometry is reported, not skipped", () => {
    const { features, dropped } = OsmCentroid.normalize([
      { type: "Feature", properties: { osm_type: "way", osm_id: 9 }, geometry: null },
    ])
    expect(features).toEqual([])
    expect(dropped).toEqual(["way/9"])
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
    // A mixed-geometry file is a hazard downstream: tools work a family at a
    // time and format conversion refuses it outright (§6.7).
    expect(outputs.map((o) => o.family).sort()).toEqual(["lines", "points"])
    expect(fs.existsSync(base)).toBe(false)
    expect(fs.existsSync(base.replace(".geojson", "-points.geojson"))).toBe(true)
  })

  test("a re-run writes beside the last one, both ways round", () => {
    const base = path.join(root, "rerun", "out.geojson")
    const points = base.replace(".geojson", "-points.geojson")
    const lines = base.replace(".geojson", "-lines.geojson")

    // This used to assert the opposite: a re-run deleted the siblings it had
    // not produced, so a directory held exactly one run's files. That rule was
    // replaced by numbering (§6.7) — a download costs minutes and the same path
    // is asked for again all the time, so the earlier run stays and the later
    // one takes the next name.
    OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(fs.existsSync(points) && fs.existsSync(lines)).toBe(true)

    // …then a run that produces only points. It lands on a numbered base, and
    // the previous run's two files are none of its business.
    const second = OsmOutput.write(base, [feature(1, "Point")])
    expect(second.outputs[0]!.path).toBe(path.join(root, "rerun", "out-1.geojson"))
    expect(fs.existsSync(points) && fs.existsSync(lines)).toBe(true)

    // And back the other way: a splitting run after an unsplit one.
    const third = OsmOutput.write(base, [feature(1, "Point"), feature(2, "LineString")])
    expect(third.outputs.map((o) => o.path).sort()).toEqual([
      path.join(root, "rerun", "out-2-lines.geojson"),
      path.join(root, "rerun", "out-2-points.geojson"),
    ])
    expect(fs.existsSync(path.join(root, "rerun", "out-1.geojson"))).toBe(true)
  })

  test("an empty list still produces a file rather than throwing", () => {
    // The service never calls it this way — `writeIfAny` stops at zero features
    // because an empty file is not worth creating. The tolerance stays so that
    // a direct call cannot fall off the end of an empty family map.
    const base = path.join(root, "empty", "out.geojson")
    const { outputs } = OsmOutput.write(base, [])
    expect(outputs[0]!.family).toBe("empty")
    expect(JSON.parse(fs.readFileSync(base, "utf-8")).features).toEqual([])
  })

  test("a base that is not named .geojson still gets three distinct files", () => {
    // The sibling name is built by inserting the family before the extension.
    // Deriving it by rewriting a ".geojson" suffix meant any other extension
    // produced a sibling equal to the base itself: three families overwriting
    // one file, then the stale-sibling sweep deleting the survivor — a download
    // that reported three outputs and left nothing on disk.
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
