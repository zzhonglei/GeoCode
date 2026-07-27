export * as QgisDiagnostics from "./diagnostics"

import { existsSync } from "node:fs"
import path from "node:path"
import type { Choice, Diagnostics, Track } from "./types"

/* --- GeoCode: the diagnostics bundle (docs/GEOKERNEL.md §4.10).
 *
 * Carries every fact needed to locate a failure without a log file: what was
 * chosen and what else was available, which paths exist and which are missing,
 * and the probe's own words. The intended reader screenshots this — which is
 * exactly why the environment view here is filtered while the execution
 * environment stays complete (§4.3 principle 8). --- */

/**
 * Variables worth SHOWING. A keep-list is the right polarity at a display
 * exit — nothing leaks that was not explicitly admitted — and the wrong one
 * for execution, which is why execution never goes through this function.
 *
 * Deliberately small. The old build carried thirty-odd system variables here
 * because its filtered copy doubled as the spawn environment; with the two
 * split, everything that does not help diagnose a QGIS problem is noise on
 * the screen and one more value to worry about leaking.
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
 * Targeted existence checks — the handful of paths whose absence explains most
 * failures, rendered as at-a-glance pass/fail marks.
 *
 * Items are DEFINED PER TRACK (§4.10). The two checks that hang off registered
 * dynamic-library directories have nothing to read on macOS and on the bridge
 * track — neither registers any (§4.3 principle 5) — and reusing one item list
 * would leave the two most-travelled paths with the weakest diagnostics. Each
 * takes its equivalent instead: macOS looks in the install's library
 * directory, the bridge looks along the executable search path it adopted.
 */
export function pathChecks(input: CheckInput): Record<string, boolean> {
  const platform = input.platform ?? process.platform
  const checks: Record<string, boolean> = {}
  const separator = platform === "win32" ? ";" : ":"

  // The Python package entry point, on every module-path entry.
  for (const entry of (input.env.PYTHONPATH ?? "").split(separator).filter(Boolean)) {
    const marker = path.join(entry, "qgis", "__init__.py")
    checks[marker] = existsSync(marker)
  }

  // The native core library — location depends on the track.
  if (platform === "win32") {
    if (input.dllDirectories.length > 0) {
      // Manual track: it will load from a registered directory or not at all.
      for (const dir of input.dllDirectories) {
        const lib = path.join(dir, "qgis_core.dll")
        checks[lib] = existsSync(lib)
      }
      // The Qt core library, checked only inside directories that look like a
      // Qt root — checking every registered directory would bury the signal
      // in noise (§4.10).
      for (const dir of input.dllDirectories) {
        const parent = path.basename(path.dirname(dir)).toLowerCase()
        if (path.basename(dir).toLowerCase() !== "bin" || (parent !== "qt5" && parent !== "qt6")) continue
        const lib = path.join(dir, parent === "qt6" ? "Qt6Core.dll" : "Qt5Core.dll")
        checks[lib] = existsSync(lib)
      }
    } else {
      // Bridge track: no registered directories by design. The equivalents
      // come from what the launcher exported — the sub-prefix's executable
      // directory, and the adopted search path.
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
    // macOS equivalent — with BOTH generations' locations. The older bundle
    // keeps the core library under the prefix's lib directory; the current one
    // keeps it in Frameworks beside Contents (verified against a real 3.44.9
    // install, where the lib directory does not exist at all). Checking only
    // the old spot painted a false red mark on every healthy modern install.
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
