import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { GeoNaming } from "@/geo/naming"
import { OsmOutput } from "@/geo/osm/output"
import { QgisDestination } from "@/geo/qgis/destination"
import type { QgisCatalog } from "@/geo/qgis/catalog"

/* The one shape a repeated output is named with (docs/GEOKERNEL.md §6.7, §4.12).
 *
 * Two tools write to the user's disk and neither may overwrite, because undo
 * does not reach what they write (§10.1 #6). Numbering is what both do instead,
 * and the user meets both — a download and an algorithm output land in the same
 * folder, often in the same task.
 *
 * This file exists because the rule was written twice and the copies HAD
 * drifted: OSM produced `out-1.geojson` under a header claiming it numbered
 * "the way a browser does", while the QGIS side genuinely did. Nothing was
 * wrong with either on its own, which is exactly why nothing caught it. The
 * agreement is structural now — one function, two callers — and the last test
 * below is what keeps it that way if someone reaches for a local copy again.
 */

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
    // `out (1).shp` — not `out-1.shp`, not `out_1.shp`, not `out.shp (1)`.
    // The audience is geographers rather than programmers; this is the shape
    // they already read every time they download the same file twice.
    expect(GeoNaming.numbered("/tmp/out.shp", 1)).toBe("/tmp/out (1).shp")
    expect(GeoNaming.numbered("/tmp/out.shp", 12)).toBe("/tmp/out (12).shp")
    expect(GeoNaming.numbered("/tmp/scene.tif", 1)).toBe("/tmp/scene (1).tif")
    // Nothing to insert before: the number simply ends the name.
    expect(GeoNaming.numbered("/tmp/report", 1)).toBe("/tmp/report (1)")
    // A name that is all extension keeps it — basename() and extname() disagree
    // about dotfiles, and the result must still be openable.
    expect(path.extname(GeoNaming.numbered("/tmp/a.b.tif", 1))).toBe(".tif")
  })

  test("the extension is never moved to the end", () => {
    // Every reader in a GIS chain dispatches on the extension. A name ending
    // `(1)` is one no tool downstream can open, including the tool that was
    // asked to produce it.
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
    // `taken` is a parameter because only the caller knows what a claim is: one
    // file for an algorithm output, a file OR any sibling it might split into
    // for a download.
    const claimed = new Set(["/tmp/out.shp", "/tmp/out (1).shp"])
    expect(GeoNaming.firstFree("/tmp/out.shp", (candidate) => claimed.has(candidate), "unused")).toBe(
      "/tmp/out (2).shp",
    )
  })

  test("exhaustion raises with the caller's own advice", () => {
    // Too rare to be worth a shared sentence: one caller says "before
    // downloading again", the other "before running this again".
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
    /* THE assertion this file is for.
     *
     * Compared rather than described, because a described agreement is what was
     * already in place — OSM's header said "the way a browser does" while its
     * code said otherwise, and no test disagreed with either. Two directories
     * so neither module's siblings interfere with the other's.
     */
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
    // OSM's own addition on top of the shared shape: `x (1)-points.geojson`
    // rather than `x-points (1).geojson`, so the three files of a split run
    // read as one thing in a directory listing.
    const where = dir()
    fs.writeFileSync(path.join(where, "x.geojson"), "taken")
    expect(path.basename(OsmOutput.free(path.join(where, "x.geojson")))).toBe("x (1).geojson")
  })
})
