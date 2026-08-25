import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { GeoNaming } from "@/geo/naming"
import { OsmOutput } from "@/geo/osm/output"
import { QgisDestination } from "@/geo/qgis/destination"
import type { QgisCatalog } from "@/geo/qgis/catalog"

/* The one shape a repeated output is named with (docs/GEOKERNEL.md §6.7, §4.12): one function, two callers, and
 * the comparison that catches either of them growing a local copy of it. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-naming-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
function dir(): string {
  const made = path.join(root, `case-${counter++}`)
  fs.mkdirSync(made, { recursive: true })
  return made
}

describe("the shape", () => {
  test("a number is inserted before the extension, in the browser's spelling", () => {
    expect(GeoNaming.numbered("/tmp/out.shp", 1)).toBe("/tmp/out (1).shp")
    expect(GeoNaming.numbered("/tmp/out.shp", 12)).toBe("/tmp/out (12).shp")
    expect(GeoNaming.numbered("/tmp/scene.tif", 1)).toBe("/tmp/scene (1).tif")
    expect(GeoNaming.numbered("/tmp/report", 1)).toBe("/tmp/report (1)")
    expect(path.extname(GeoNaming.numbered("/tmp/a.b.tif", 1))).toBe(".tif")
  })

  test("the extension is never moved to the end", () => {
    for (const base of ["/tmp/x.shp", "/tmp/x.tif", "/tmp/x.gpkg", "/tmp/x.geojson"]) {
      expect(path.extname(GeoNaming.numbered(base, 3))).toBe(path.extname(base))
    }
  })
})

describe("finding a free one", () => {
  test("an unclaimed name is returned as it stands", () => {
    expect(GeoNaming.firstFree("/tmp/out.shp", () => false, "unused")).toBe("/tmp/out.shp")
  })

  test("claims are the caller's to define, and counting starts at one", () => {
    const claimed = new Set(["/tmp/out.shp", "/tmp/out (1).shp"])
    expect(GeoNaming.firstFree("/tmp/out.shp", (candidate) => claimed.has(candidate), "unused")).toBe(
      "/tmp/out (2).shp",
    )
  })

  test("exhaustion raises with the caller's own advice", () => {
    expect(() => GeoNaming.firstFree("/tmp/out.shp", () => true, "clear some first")).toThrow("clear some first")
  })
})

describe("both faces answer with the same shape", () => {
  const sink: QgisCatalog.Algorithm = {
    id: "native:test",
    name: "Test",
    group: "Testing",
    description: "",
    helpText: "",
    parameters: [
      { name: "OUTPUT", description: "out", type: "sink", defaultValue: null, options: [], optional: false },
    ],
    outputs: [],
  }

  test("a download and an algorithm output number a taken name identically", () => {
    const forOsm = dir()
    const forQgis = dir()
    fs.writeFileSync(path.join(forOsm, "out.geojson"), "taken")
    fs.writeFileSync(path.join(forQgis, "out.geojson"), "taken")

    const fromOsm = OsmOutput.free(path.join(forOsm, "out.geojson"))
    const fromQgis = QgisDestination.reserve(sink, { OUTPUT: path.join(forQgis, "out.geojson") })[0]!.actual

    expect(path.basename(fromOsm)).toBe("out (1).geojson")
    expect(path.basename(fromQgis)).toBe(path.basename(fromOsm))
  })

  test("a split download carries the number on the base, so its files stay one run", () => {
    const where = dir()
    fs.writeFileSync(path.join(where, "x.geojson"), "taken")
    expect(path.basename(OsmOutput.free(path.join(where, "x.geojson")))).toBe("x (1).geojson")
  })
})
