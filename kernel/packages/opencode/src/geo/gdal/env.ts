export * as GdalEnv from "./env"

import { existsSync } from "node:fs"
import path from "node:path"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: GDAL toolchain discovery, kept to file checks and string building so it can run on every config change
 * (docs/GEOKERNEL.md §7.3). --- */

const RASTER_TOOLS = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem"] as const
const VECTOR_TOOLS = ["ogrinfo", "ogr2ogr"] as const

export const TOOLS = [...RASTER_TOOLS, ...VECTOR_TOOLS] as const
export type Tool = (typeof TOOLS)[number]

export type Platform = NodeJS.Platform
export type Exists = (target: string) => boolean

/** Follows the target platform, not the host, so Windows layouts are testable anywhere. */
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

export function rasterUsable(status: GeoEvent.GdalStatus): boolean {
  return status.status === "ready" || status.status === "raster-only"
}

export function vectorUsable(status: GeoEvent.GdalStatus): boolean {
  return status.status === "ready" || status.status === "vector-only"
}

/** Several exist and are empty on a partial install, so the marker file is the test, not the directory (§7.3). */
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
    // Has shipped in GDAL's data directory for its whole modern history, so absence is decisive.
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

/** macOS gets nothing: installs there resolve resources from paths recorded at build time (§7.3). */
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
    // Both spellings: which one is read depends on the version installed.
    env.PROJ_LIB = proj
    env.PROJ_DATA = proj
  }

  const data = resolveResource("gdal", root, exists, p)
  if (data) env.GDAL_DATA = data

  // Tool directory first, so the libraries beside the executables resolve.
  env.PATH = `${directory};${inherited.PATH ?? ""}`

  // Without it, `C:\项目\data.tif` fails to open inside the library on a Chinese-locale machine.
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return env
}
