import { describe, expect, test } from "bun:test"
import { Ignore } from "../src/filesystem/ignore"
import { GeoExtensions } from "../src/filesystem/geo-extensions"
import { Glob } from "../src/util/glob"

/* The watcher's GIS ignore list (docs/GEOKERNEL.md §10.1 #7).
 *
 * A tripwire, not a unit test. The patterns are trivially correct; what is not
 * trivially true is that they reach the running watcher, and that is exactly
 * what an upstream refactor can take away without any type error. */

describe("geo watcher ignore", () => {
  test("the transient patterns are actually in the list the watcher subscribes with", () => {
    // `watcher.ts` spreads `Ignore.PATTERNS` into the subscribe call. That is
    // the ONLY route a default ignore has to the runtime — core cannot import
    // opencode — so being absent here means the rules exist and do nothing.
    expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS.length).toBeGreaterThan(0)
    for (const pattern of Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS) {
      expect(Ignore.PATTERNS).toContain(pattern)
    }
  })

  test("a GeoPackage under edit does not wake the watcher on every write", () => {
    // One QGIS session rewrites the write-ahead log hundreds of times.
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
    // Only the churn is silenced. A raster the user just produced is the whole
    // reason they are looking at the tree.
    for (const file of ["data/city.gpkg", "data/dem.tif", "data/layer.shp", "project.qgs"]) {
      expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS.some((pattern) => Glob.match(pattern, file))).toBe(false)
    }
  })

  test("intermediate outputs under tmp are not ignored", () => {
    // GIS tools write intermediate results to tmp/, and upstream's default
    // ignore would hide them. Removed deliberately, and marked so an upstream
    // re-add conflicts rather than silently restoring it.
    expect(Ignore.PATTERNS).not.toContain("**/tmp/**")
    expect(Ignore.match("tmp/clipped.tif")).toBe(false)
  })

  test("the suffixes come from the shared taxonomy, not a second list", () => {
    // Two hand-maintained lists drift; that is the entire reason the taxonomy
    // exists (§10.1 #5).
    expect(Ignore.GEOCODE_WATCHER_IGNORE_PATTERNS).toEqual(
      GeoExtensions.TRANSIENT_SUFFIXES.map((suffix) => `**/*.${suffix}`),
    )
  })
})
