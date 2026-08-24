export * as QgisDiagnostics from "./diagnostics"

import { existsSync } from "node:fs"
import path from "node:path"
import type { Choice, Diagnostics, Track } from "./types"

/* --- GeoCode: the diagnostics bundle (docs/GEOKERNEL.md §4.10). Everything needed to locate a failure without a
 * log file, and the one place the environment is filtered — execution keeps the complete one (§4.3 principle 8). --- */

/**
 * Variables worth showing. A keep-list only works at a display exit, where the cost of dropping one is a missing
 * line; execution needs the opposite polarity and so never comes through here (§4.3 principle 8).
 */
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

/**
 * Existence checks, defined per track (§4.10): macOS and the bridge track register no dynamic-library directories
 * (§4.3 principle 5), so the core library is looked for wherever each of them actually keeps it.
 */
export function pathChecks(input: CheckInput): Record<string, boolean> {
  const platform = input.platform ?? process.platform
  const checks: Record<string, boolean> = {}
  const separator = platform === "win32" ? ";" : ":"

  // One finding, not one per module-path entry: the other module directories and whatever the user's own PYTHONPATH
  // contributed are not supposed to carry the package, so per-entry marks put guaranteed crosses on a healthy
  // install. Only when it is nowhere do the candidates become the diagnosis.
  const entries = (input.env.PYTHONPATH ?? "").split(separator).filter(Boolean)
  const moduleEntries = entries.filter((entry) => path.basename(entry).toLowerCase() !== "plugins")
  const packageMarkers = moduleEntries.map((entry) => path.join(entry, "qgis", "__init__.py"))
  const foundPackage = packageMarkers.find((marker) => existsSync(marker))
  if (foundPackage) {
    checks[foundPackage] = true
  } else {
    for (const marker of packageMarkers) checks[marker] = false
  }

  // The plugins entry carries processing instead — the subsystem the ready status reports on.
  for (const entry of entries) {
    if (path.basename(entry).toLowerCase() !== "plugins") continue
    const marker = path.join(entry, "processing", "__init__.py")
    checks[marker] = existsSync(marker)
  }

  // The native core library, wherever the platform and the track keep it.
  if (platform === "win32") {
    if (input.dllDirectories.length > 0) {
      // Manual track: it will load from a registered directory or not at all.
      for (const dir of input.dllDirectories) {
        const lib = path.join(dir, "qgis_core.dll")
        checks[lib] = existsSync(lib)
      }
      // Qt only inside directories that look like a Qt root; the registered set is wide, and checking all of it
      // would bury the signal (§4.10).
      for (const dir of input.dllDirectories) {
        const parent = path.basename(path.dirname(dir)).toLowerCase()
        if (path.basename(dir).toLowerCase() !== "bin" || (parent !== "qt5" && parent !== "qt6")) continue
        const lib = path.join(dir, parent === "qt6" ? "Qt6Core.dll" : "Qt5Core.dll")
        checks[lib] = existsSync(lib)
      }
    } else {
      // Bridge track: nothing registered, by design (§4.3 principle 5), so the equivalents come from what the
      // launcher exported — the prefix's executable directory and the adopted search path.
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
    // Both generations: the older bundle keeps the core library under the prefix's lib directory, the current one in
    // Frameworks beside it and ships no lib directory at all (3.44.9) — the old spot alone would mark it missing.
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

  // Projection database — the payload, never the directory (§4.3 principle 4).
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

/** A minimal bundle for failures reached before any assembly existed. */
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
