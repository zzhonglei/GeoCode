export * as GdalEnv from "./env"

import { existsSync } from "node:fs"
import path from "node:path"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the GDAL toolchain — what is available, and what a subprocess
 * needs to use it (docs/GEOKERNEL.md §7.3).
 *
 * Everything here is pure and synchronous: file existence and string building,
 * no subprocesses. That is what lets the probe run on every config change
 * without a cost worth thinking about, and it is why this module has no
 * intermediate state — there is nothing to wait for.
 *
 * The filesystem and the platform arrive as parameters rather than being read
 * from the ambient world, because the interesting cases here are all Windows
 * layouts that the machine running the tests does not have. --- */

/**
 * The two tracks, and what each one needs.
 *
 * They are DISJOINT, which is the whole reason the status has six states
 * instead of two: an install missing only the vector binaries still previews
 * rasters perfectly, and telling that user "GDAL is not configured" would be
 * both false and unactionable (§7.3).
 */
const RASTER_TOOLS = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem"] as const
const VECTOR_TOOLS = ["ogrinfo", "ogr2ogr"] as const

export const TOOLS = [...RASTER_TOOLS, ...VECTOR_TOOLS] as const
export type Tool = (typeof TOOLS)[number]

export type Platform = NodeJS.Platform
export type Exists = (target: string) => boolean

/**
 * Path handling follows the TARGET platform, not the running one.
 *
 * Every layout this module knows about is a Windows layout, so a function that
 * silently used the host separator could only ever be exercised on Windows —
 * and the resource-candidate logic is precisely the part that fails far from
 * its cause when it is wrong. Honouring the parameter is what makes it
 * testable anywhere.
 */
function paths(platform: Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

export function toolPath(directory: string, tool: Tool, platform: Platform = process.platform): string {
  return paths(platform).join(directory, platform === "win32" ? `${tool}.exe` : tool)
}

export function toolPaths(directory: string, platform: Platform = process.platform): Record<Tool, string> {
  // Written out rather than reduced from TOOLS: this way the compiler notices
  // when a tool is added and nobody gave it a path.
  return {
    gdalinfo: toolPath(directory, "gdalinfo", platform),
    gdalwarp: toolPath(directory, "gdalwarp", platform),
    gdal_translate: toolPath(directory, "gdal_translate", platform),
    gdaldem: toolPath(directory, "gdaldem", platform),
    ogrinfo: toolPath(directory, "ogrinfo", platform),
    ogr2ogr: toolPath(directory, "ogr2ogr", platform),
  }
}

/**
 * Which of the six states this configuration is in.
 *
 * `missing` always names the tools whose absence caused the shortfall being
 * reported — for a one-track state that is the BROKEN track's tools, not the
 * working one's. A user reading "raster-only" wants to know what to install to
 * get the other half.
 */
export function classify(
  directory: string | undefined,
  options: { readonly platform?: Platform; readonly exists?: Exists } = {},
): GeoEvent.GdalStatus {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync

  if (!directory || directory.trim() === "") return { status: "unconfigured" }
  if (!exists(directory)) return { status: "dir-missing", directory }

  const missingRaster = RASTER_TOOLS.filter((tool) => !exists(toolPath(directory, tool, platform)))
  const missingVector = VECTOR_TOOLS.filter((tool) => !exists(toolPath(directory, tool, platform)))

  if (missingRaster.length === 0 && missingVector.length === 0) return { status: "ready" }
  if (missingRaster.length > 0 && missingVector.length > 0) {
    return { status: "unusable", missing: [...missingRaster, ...missingVector] }
  }
  if (missingRaster.length === 0) return { status: "raster-only", missing: [...missingVector] }
  return { status: "vector-only", missing: [...missingRaster] }
}

/** Whether a track can be used, read off the status the probe produced. */
export function rasterUsable(status: GeoEvent.GdalStatus): boolean {
  return status.status === "ready" || status.status === "raster-only"
}

export function vectorUsable(status: GeoEvent.GdalStatus): boolean {
  return status.status === "ready" || status.status === "vector-only"
}

/**
 * Directories a resource might live in, across the layouts that coexist on
 * Windows, and the file that proves it is the real one.
 *
 * Existence of the DIRECTORY is not the test. Several of these paths exist and
 * are empty on a partial install, and adopting an empty one produces the exact
 * failure this whole mechanism exists to prevent — "cannot find the projection
 * database" — from a place nowhere near the cause (§7.3).
 */
const RESOURCES = {
  proj: {
    marker: "proj.db",
    candidates: (root: string, p: typeof path.win32) => [
      p.join(root, "share", "proj"),
      p.join(root, "apps", "proj", "share", "proj"),
      p.join(root, "Library", "share", "proj"),
    ],
  },
  gdal: {
    // `default.rsc` has shipped in GDAL's data directory for its whole modern
    // history, and unlike the directory itself it cannot be there by accident.
    marker: "default.rsc",
    candidates: (root: string, p: typeof path.win32) => [
      p.join(root, "share", "gdal"),
      p.join(root, "apps", "gdal", "share", "gdal"),
      p.join(root, "Library", "share", "gdal"),
    ],
  },
} as const

function resolveResource(
  kind: keyof typeof RESOURCES,
  root: string,
  exists: Exists,
  p: typeof path.win32,
): string | undefined {
  const { marker, candidates } = RESOURCES[kind]
  return candidates(root, p).find((candidate) => exists(p.join(candidate, marker)))
}

/**
 * The environment a GDAL subprocess needs, for this platform.
 *
 * **macOS gets nothing, and that is the correct answer** — installations there
 * record their search paths at build time and find their own libraries and
 * resources. Injecting anything would at best duplicate what the binary
 * already knows and at worst override a working install with our guess.
 *
 * Windows is the opposite: the installers place resources at a known spot
 * inside the installation but register nothing globally, so a subprocess that
 * inherits only the user's environment cannot find them. The four categories
 * below are each load-bearing, and each fails far from its cause when absent.
 */
export function subprocessEnv(
  directory: string,
  options: {
    readonly platform?: Platform
    readonly exists?: Exists
    readonly inherited?: NodeJS.ProcessEnv
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") return {}

  const exists = options.exists ?? existsSync
  const inherited = options.inherited ?? process.env
  const p = paths(platform)
  const root = p.resolve(directory, "..")
  const env: Record<string, string> = {}

  const proj = resolveResource("proj", root, exists, p)
  if (proj) {
    // Both spellings, because which one is read depends on the version and we
    // do not control which version the user installed.
    env.PROJ_LIB = proj
    env.PROJ_DATA = proj
  }

  const data = resolveResource("gdal", root, exists, p)
  if (data) env.GDAL_DATA = data

  // The tool directory goes first so the libraries sitting beside the
  // executables resolve when it loads them.
  env.PATH = `${directory};${inherited.PATH ?? ""}`

  // Interpret filenames as UTF-8 rather than the system code page. Without it,
  // a path like `C:\项目\data.tif` fails to open INSIDE the library on a
  // Chinese-locale machine, even though the process received it intact.
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return env
}
