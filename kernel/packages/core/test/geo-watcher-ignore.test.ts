import { describe, expect, test } from "bun:test"
import { Ignore } from "../src/filesystem/ignore"
import { GeoExtensions } from "../src/filesystem/geo-extensions"
import { Glob } from "../src/util/glob"

// An upstream refactor can cut the GIS ignore patterns off from the list filesystem/watcher.ts subscribes with, and
// no type error follows (docs/GEOKERNEL.md §10.1 #7).

describe("geo watcher ignore", () => {
  test("the transient patterns are actually in the list the watcher subscribes with", () => {
    expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS.length).toBeGreaterThan(0)
    for (const pattern of Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS) {
      expect(Ignore.PATTERNS).toContain(pattern)
    }
  })

  test("a GeoPackage under edit does not wake the watcher on every write", () => {
    const churn = [
      "data/city.gpkg-wal",
      "data/city.gpkg-shm",
      "data/city.gpkg-journal",
      "project.qgs~",
      "project.qgz.lock",
      "project.qgs.autosave",
    ]
    for (const file of churn) {
      expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS.some((pattern) => Glob.match(pattern, file))).toBe(true)
    }
  })

  test("the data itself still reaches the watcher", () => {
    for (const file of ["data/city.gpkg", "data/dem.tif", "data/layer.shp", "project.qgs"]) {
      expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS.some((pattern) => Glob.match(pattern, file))).toBe(false)
    }
  })

  test("intermediate outputs under tmp are not ignored", () => {
    // Upstream's own default ignores `**/tmp/**`, where GIS tools write intermediate outputs.
    expect(Ignore.PATTERNS).not.toContain("**/tmp/**")
    expect(Ignore.match("tmp/clipped.tif")).toBe(false)
  })

  test("the suffixes come from the shared taxonomy, not a second list", () => {
    expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS).toEqual(
      GeoExtensions.TRANSIENT_SUFFIXES.map((suffix) => `**/*.${suffix}`),
    )
  })
})
