import { describe, expect, test } from "bun:test"
import path from "node:path"
import { GdalEnv } from "@/geo/gdal/env"

/* Toolchain discovery and subprocess environment (docs/GEOKERNEL.md §7.3). */

/** A filesystem given as the paths in it, normalized as Windows does because these fixtures are Windows layouts. */
const fsWith = (...paths: string[]) => {
  const present = new Set(paths.map((p) => path.win32.normalize(p)))
  return (target: string) => present.has(path.win32.normalize(target))
}

const win = (...parts: string[]) => path.win32.join(...parts)

const WIN = { platform: "win32" as const }
const NIX = { platform: "darwin" as const }

const BIN = "C:\\OSGeo4W\\bin"
const winTools = (...tools: string[]) => tools.map((t) => win(BIN, `${t}.exe`))
const ALL_TOOLS = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem", "ogrinfo", "ogr2ogr"]

describe("gdal toolchain classification", () => {
  test("an unset directory is unconfigured, not broken", () => {
    expect(GdalEnv.classify(undefined, { ...WIN, exists: fsWith() })).toEqual({ status: "unconfigured" })
    expect(GdalEnv.classify("   ", { ...WIN, exists: fsWith() })).toEqual({ status: "unconfigured" })
  })

  test("a directory that is not there says which one", () => {
    const status = GdalEnv.classify(BIN, { ...WIN, exists: fsWith() })
    expect(status).toEqual({ status: "dir-missing", directory: BIN })
  })

  test("both tracks present is ready", () => {
    const exists = fsWith(BIN, ...winTools(...ALL_TOOLS))
    expect(GdalEnv.classify(BIN, { ...WIN, exists })).toEqual({ status: "ready" })
  })

  test("one track alone still works, and the report names what the other one lacks", () => {
    const rasterOnly = GdalEnv.classify(BIN, {
      ...WIN,
      exists: fsWith(BIN, ...winTools("gdalinfo", "gdalwarp", "gdal_translate", "gdaldem")),
    })
    expect(rasterOnly).toEqual({ status: "raster-only", missing: ["ogrinfo", "ogr2ogr"] })

    const vectorOnly = GdalEnv.classify(BIN, { ...WIN, exists: fsWith(BIN, ...winTools("ogrinfo", "ogr2ogr")) })
    expect(vectorOnly).toEqual({
      status: "vector-only",
      missing: ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem"],
    })
  })

  test("gaps in both tracks is one wrong directory, and the list says so", () => {
    const status = GdalEnv.classify(BIN, { ...WIN, exists: fsWith(BIN, ...winTools("gdalinfo", "ogrinfo")) })
    expect(status).toEqual({
      status: "unusable",
      missing: ["gdalwarp", "gdal_translate", "gdaldem", "ogr2ogr"],
    })
  })

  test("executables carry the platform's suffix", () => {
    expect(GdalEnv.toolPath("/usr/local/bin", "gdalinfo", "darwin")).toBe("/usr/local/bin/gdalinfo")
    expect(GdalEnv.toolPath(BIN, "gdalinfo", "win32")).toBe("C:\\OSGeo4W\\bin\\gdalinfo.exe")
  })

  test("track usability is read off the status, not recomputed", () => {
    const of = (status: string, missing: string[] = []) => ({ status, missing }) as never
    expect(GdalEnv.rasterUsable(of("ready"))).toBe(true)
    expect(GdalEnv.rasterUsable(of("raster-only"))).toBe(true)
    expect(GdalEnv.rasterUsable(of("vector-only"))).toBe(false)
    expect(GdalEnv.vectorUsable(of("vector-only"))).toBe(true)
    expect(GdalEnv.vectorUsable(of("unusable"))).toBe(false)
  })
})

describe("gdal subprocess environment", () => {
  test("macOS is handed nothing at all", () => {
    expect(GdalEnv.subprocessEnv("/opt/homebrew/bin", { ...NIX, exists: () => true })).toEqual({})
  })

  test("Windows resource directories are chosen by their contents, not their existence", () => {
    // The first candidate, share\proj, is present here with no proj.db in it, so only the marker can decide.
    const root = "C:\\OSGeo4W"
    const real = win(root, "apps", "proj", "share", "proj")
    const env = GdalEnv.subprocessEnv(BIN, {
      ...WIN,
      inherited: { PATH: "C:\\Windows" },
      exists: fsWith(win(root, "share", "proj"), real, win(real, "proj.db")),
    })
    expect(env.PROJ_LIB).toBe(real)
    // Both spellings, because which one is read depends on the version installed.
    expect(env.PROJ_DATA).toBe(real)
  })

  test("a resource with no candidate carrying its marker is simply not set", () => {
    const env = GdalEnv.subprocessEnv(BIN, {
      ...WIN,
      inherited: {},
      exists: fsWith(win("C:\\OSGeo4W", "share", "proj")),
    })
    expect(env.PROJ_LIB).toBeUndefined()
    expect(env.GDAL_DATA).toBeUndefined()
  })

  test("the data directory is chosen the same way, by its own marker", () => {
    const root = "C:\\OSGeo4W"
    const real = win(root, "apps", "gdal", "share", "gdal")
    const env = GdalEnv.subprocessEnv(BIN, {
      ...WIN,
      inherited: {},
      exists: fsWith(win(root, "share", "gdal"), real, win(real, "default.rsc")),
    })
    expect(env.GDAL_DATA).toBe(real)
  })

  test("the tool directory leads PATH, and filenames are forced to UTF-8", () => {
    const env = GdalEnv.subprocessEnv(BIN, { ...WIN, inherited: { PATH: "C:\\Windows" }, exists: fsWith() })
    expect(env.PATH).toBe(`${BIN};C:\\Windows`)
    expect(env.GDAL_FILENAME_IS_UTF8).toBe("YES")
  })
})
