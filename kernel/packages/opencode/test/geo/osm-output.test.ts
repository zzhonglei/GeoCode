import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OsmConvert } from "@/geo/osm/convert"
import { OsmOutput } from "@/geo/osm/output"

/* Writing results to disk (docs/GEOKERNEL.md §6.7): a name that is taken is numbered, never overwritten. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-osm-out-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
/** A fresh directory per test, so one test's files cannot number another's. */
function dir(): string {
  const made = path.join(root, `case-${counter++}`)
  fs.mkdirSync(made, { recursive: true })
  return made
}

const feature = (type: string, coordinates: unknown, id: number): OsmConvert.Feature =>
  ({
    type: "Feature",
    geometry: { type, coordinates },
    properties: { osm_id: id, osm_type: "way", name: `f${id}`, category: "-" },
  }) as unknown as OsmConvert.Feature

const POINT = feature("Point", [114, 30], 1)
const AREA = feature(
  "Polygon",
  [
    [
      [114, 30],
      [115, 30],
      [115, 31],
      [114, 30],
    ],
  ],
  2,
)

describe("numbering, because a download is not disposable", () => {
  test("the first run gets the name it asked for", () => {
    const where = dir()
    const result = OsmOutput.write(path.join(where, "wuhan.geojson"), [AREA])
    expect(result.outputs.map((entry) => entry.path)).toEqual([path.join(where, "wuhan.geojson")])
    expect(result.bytes).toBeGreaterThan(0)
  })

  test("a second run beside it is numbered, and the first is not touched", () => {
    const where = dir()
    const asked = path.join(where, "wuhan.geojson")
    OsmOutput.write(asked, [AREA])
    const before = fs.readFileSync(asked, "utf-8")

    const second = OsmOutput.write(asked, [POINT])
    expect(second.outputs.map((entry) => entry.path)).toEqual([path.join(where, "wuhan (1).geojson")])
    expect(fs.readFileSync(asked, "utf-8")).toBe(before)
    expect(JSON.parse(fs.readFileSync(path.join(where, "wuhan (1).geojson"), "utf-8")).features).toHaveLength(1)
  })

  test("and a third keeps counting", () => {
    const where = dir()
    const asked = path.join(where, "wuhan.geojson")
    OsmOutput.write(asked, [AREA])
    OsmOutput.write(asked, [AREA])
    expect(OsmOutput.write(asked, [AREA]).outputs[0]!.path).toBe(path.join(where, "wuhan (2).geojson"))
  })

  test("the number goes on the base, so a split run's files stay one run", () => {
    const where = dir()
    const asked = path.join(where, "mixed.geojson")
    OsmOutput.write(asked, [AREA])

    const second = OsmOutput.write(asked, [POINT, AREA])
    expect(second.outputs.map((entry) => entry.path).sort()).toEqual([
      path.join(where, "mixed (1)-points.geojson"),
      path.join(where, "mixed (1)-polygons.geojson"),
    ])
    expect(second.outputs.map((entry) => entry.family).sort()).toEqual(["points", "polygons"])
  })

  test("a name is taken when only its siblings exist", () => {
    const where = dir()
    const asked = path.join(where, "campus.geojson")
    OsmOutput.write(asked, [POINT, AREA])
    expect(fs.existsSync(asked)).toBe(false)
    expect(fs.existsSync(path.join(where, "campus-points.geojson"))).toBe(true)

    const second = OsmOutput.write(asked, [AREA])
    expect(second.outputs[0]!.path).toBe(path.join(where, "campus (1).geojson"))
  })

  test("a split run beside a split run, which is the case the other three miss", () => {
    const where = dir()
    const asked = path.join(where, "keep.geojson")
    OsmOutput.write(asked, [POINT, AREA])
    const points = path.join(where, "keep-points.geojson")

    const second = OsmOutput.write(asked, [POINT, AREA])
    expect(second.outputs.map((entry) => entry.path).sort()).toEqual([
      path.join(where, "keep (1)-points.geojson"),
      path.join(where, "keep (1)-polygons.geojson"),
    ])
    expect(JSON.parse(fs.readFileSync(points, "utf-8")).features).toHaveLength(1)
  })

  test("a path that does not say GeoJSON is told to", () => {
    const where = dir()
    const result = OsmOutput.write(path.join(where, "wuhan"), [AREA])
    expect(result.outputs[0]!.path).toBe(path.join(where, "wuhan.geojson"))
  })

  test("a missing parent directory is created", () => {
    const where = path.join(dir(), "nested", "deeper")
    const result = OsmOutput.write(path.join(where, "out.geojson"), [AREA])
    expect(result.outputs[0]!.path).toBe(path.join(where, "out.geojson"))
    expect(fs.existsSync(path.join(where, "out.geojson"))).toBe(true)
  })
})
