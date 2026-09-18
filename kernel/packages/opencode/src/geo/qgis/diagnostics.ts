export * as QgisDiagnostics from "./diagnostics"

import { existsSync } from "node:fs"
import path from "node:path"
import type { Choice, Diagnostics, Track } from "./types"

/* --- GeoCode: the diagnostics bundle, and the one place the environment is filtered (docs/GEOKERNEL.md §4.10). --- */

/** A keep-list only works at a display exit, where dropping a variable costs a line; never apply it to execution. */
const DISPLAY_PREFIX = /^(QGIS_|GDAL_|PROJ_|OSGEO4W_|O4W_|VSI_|QT_|PYTHON)/i
const DISPLAY_KEYS = new Set(["PATH"])

export function displayEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (DISPLAY_PREFIX.test(key) || DISPLAY_KEYS.has(key.toUpperCase())) out[key] = value
  }
  return out
}

export interface CheckInput {
  readonly prefix: string
  readonly env: Record<string, string>
  readonly dllDirectories: readonly string[]
  readonly track?: Track
  readonly platform?: NodeJS.Platform
}

export function pathChecks(input: CheckInput): Record<string, boolean> {
  const platform = input.platform ?? process.platform
  const checks: Record<string, boolean> = {}
  const separator = platform === "win32" ? ";" : ":"

  // One finding, not one per module-path entry: the other entries are not supposed to carry the package, so
  // per-entry marks would put guaranteed crosses on a healthy install.
  const entries = (input.env.PYTHONPATH ?? "").split(separator).filter(Boolean)
  const moduleEntries = entries.filter((entry) => path.basename(entry).toLowerCase() !== "plugins")
  const packageMarkers = moduleEntries.map((entry) => path.join(entry, "qgis", "__init__.py"))
  const foundPackage = packageMarkers.find((marker) => existsSync(marker))
  if (foundPackage) {
    checks[foundPackage] = true
  } else {
    for (const marker of packageMarkers) checks[marker] = false
  }

  // A plugins entry carries processing instead.
  for (const entry of entries) {
    if (path.basename(entry).toLowerCase() !== "plugins") continue
    const marker = path.join(entry, "processing", "__init__.py")
    checks[marker] = existsSync(marker)
  }

  if (platform === "win32") {
    if (input.dllDirectories.length > 0) {
      // Manual track: the core library loads from a registered directory or not at all.
      for (const dir of input.dllDirectories) {
        const lib = path.join(dir, "qgis_core.dll")
        checks[lib] = existsSync(lib)
      }
      // Qt only inside directories that look like a Qt root; the registered set is wide, and checking all of it
      // would bury the signal.
      for (const dir of input.dllDirectories) {
        const parent = path.basename(path.dirname(dir)).toLowerCase()
        if (path.basename(dir).toLowerCase() !== "bin" || (parent !== "qt5" && parent !== "qt6")) continue
        const lib = path.join(dir, parent === "qt6" ? "Qt6Core.dll" : "Qt5Core.dll")
        checks[lib] = existsSync(lib)
      }
    } else {
      // Bridge track: nothing is registered (§4.3 principle 5), so look in the prefix's bin and the adopted PATH.
      const core = path.join(input.prefix, "bin", "qgis_core.dll")
      checks[core] = existsSync(core)
      const pathDirs = (input.env.PATH ?? "").split(";").filter(Boolean)
      const qtDir = pathDirs.find((dir) => {
        const parent = path.basename(path.dirname(dir)).toLowerCase()
        return path.basename(dir).toLowerCase() === "bin" && (parent === "qt5" || parent === "qt6")
      })
      if (qtDir) {
        const parent = path.basename(path.dirname(qtDir)).toLowerCase()
        const lib = path.join(qtDir, parent === "qt6" ? "Qt6Core.dll" : "Qt5Core.dll")
        checks[lib] = existsSync(lib)
      }
    }
  } else {
    // The older bundle keeps the core library under the prefix's lib directory, the newer one only in Frameworks
    // beside it, so the old spot alone would mark it missing.
    const candidates = [
      path.join(input.prefix, "lib", "libqgis_core.dylib"),
      path.join(path.resolve(input.prefix, ".."), "Frameworks", "libqgis_core.dylib"),
    ]
    const found = candidates.find((candidate) => existsSync(candidate))
    if (found) {
      checks[found] = true
    } else {
      for (const candidate of candidates) checks[candidate] = false
    }
  }

  // The database, never the directory (§4.3 principle 4).
  for (const key of ["PROJ_LIB", "PROJ_DATA"] as const) {
    const dir = input.env[key]
    if (!dir) continue
    const db = path.join(dir, "proj.db")
    if (!(db in checks)) checks[db] = existsSync(db)
  }

  if (input.env.GDAL_DATA) checks[input.env.GDAL_DATA] = existsSync(input.env.GDAL_DATA)

  return checks
}

export interface BuildInput extends CheckInput {
  readonly python: string
  readonly choices?: Record<string, Choice>
  readonly output?: string
  readonly error?: string
  readonly attempted?: readonly Track[]
}

export function build(input: BuildInput): Diagnostics {
  return {
    python: input.python,
    prefix: input.prefix,
    env: displayEnv(input.env),
    dllDirectories: input.dllDirectories,
    checks: pathChecks(input),
    choices: input.choices ?? {},
    output: input.output,
    error: input.error,
    track: input.track,
    attempted: input.attempted,
  }
}

export function bare(python: string, error: string): Diagnostics {
  return {
    python,
    prefix: "",
    env: {},
    dllDirectories: [],
    checks: {},
    choices: {},
    error,
  }
}
