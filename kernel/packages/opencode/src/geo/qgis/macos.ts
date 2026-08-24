export * as QgisMacOS from "./macos"

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { QgisPaths } from "./paths"
import type { Choice } from "./types"

/* --- GeoCode: resolving a QGIS environment on macOS (docs/GEOKERNEL.md §4.4).
 *
 * Two install shapes, and within the app bundle two generations of layout differing in where the interpreter lives,
 * where its standard library lives, and whether the interpreter can start at all without help. --- */

/** Every bundle has an executable directory, so without a marker an unrelated application passes as a prefix. */
export function isQgisBundle(executableDir: string): boolean {
  return existsSync(path.join(executableDir, "qgis_process")) || existsSync(path.join(executableDir, "QGIS"))
}

export interface PrefixResolution {
  readonly prefix?: string
  /**
   * The hint runs through a bundle carrying no QGIS marker — a definite answer, but read off the path's shape, so
   * it is also what a bundle that is not on disk at all produces.
   */
  readonly notQgis: boolean
  /**
   * Where the executable directory would be, kept alongside a not-qgis verdict: `resolve.ts` runs its escape hatch
   * under this prefix when the hint is a real interpreter, so a missing marker cannot veto the probe (§4.3
   * principle 10).
   */
  readonly fallbackPrefix?: string
  /**
   * True only after a marker check (levels 1 and 2). The reachability precheck refuses level 3's answer on this
   * flag; without it a hint naming nothing at all would pass and come back as a probe spawn error (§4.3 可达性预检).
   */
  readonly verified: boolean
}

/** The prefix behind a hint of any shape, in three levels; only the first two verify a marker (§4.4). */
export function resolvePrefix(hint: string): PrefixResolution {
  // Level 1: up through a bundle's executable directory, which covers a hint that is the interpreter itself. A
  // marker hit is a verified answer, a miss is not a verdict — the directory is remembered and level 2 gets a turn.
  let executableDir: string | undefined
  let walking = path.dirname(hint)
  while (walking && walking !== path.dirname(walking)) {
    if (path.basename(walking) === "MacOS") {
      if (isQgisBundle(walking)) return { prefix: walking, notQgis: false, verified: true }
      executableDir = walking
      break
    }
    walking = path.dirname(walking)
  }

  // Level 2: the hint names a bundle, or anything inside one that does not pass through the executable directory.
  let sawBundle = false
  const fromBundle = QgisPaths.scanSegments(hint, (prefix, segment) => {
    if (!segment.endsWith(".app")) return undefined
    sawBundle = true
    const executableDir = path.join(prefix, "Contents", "MacOS")
    return existsSync(executableDir) && isQgisBundle(executableDir) ? executableDir : undefined
  })
  if (fromBundle) return { prefix: fromBundle, notQgis: false, verified: true }
  if (sawBundle || executableDir) {
    return { notQgis: true, verified: false, fallbackPrefix: executableDir ?? path.resolve(hint, "../..") }
  }

  // Level 3: not a bundle. Best effort for package-manager and source installs, and unverified by construction —
  // there is no marker outside a bundle, so the probe is the only judge (§4.4).
  return { prefix: path.resolve(hint, "../.."), notQgis: false, verified: false }
}

/** Two generations: `bin/python3` in the older layout, a versioned name at the prefix root in the newer (§4.4). */
export function findInterpreter(prefix: string): Choice {
  const candidates: string[] = []
  const legacy = path.join(prefix, "bin", "python3")
  if (existsSync(legacy)) candidates.push(legacy)
  for (const entry of QgisPaths.entries(prefix)) {
    // Not `isFile`: readdir reports a symlink as neither file nor directory, and this interpreter can be one.
    if (entry.isDirectory()) continue
    if (/^python3\.\d+$/.test(entry.name)) candidates.push(path.join(prefix, entry.name))
  }
  return { selected: candidates[0], candidates }
}

/**
 * By content: a versioned-Python directory holding the encodings module, which is what the interpreter reaches for
 * first. The version in the name cannot be trusted — a 3.44 bundle ships a `python3.12` interpreter whose standard
 * library sits in `python3.11` — and neither can the type, since some bundles share the library through a symlink.
 */
export function findStandardLibrary(resources: string): string | undefined {
  for (const entry of QgisPaths.entries(resources)) {
    if (!/^python3\.\d+$/.test(entry.name)) continue
    const candidate = path.join(resources, entry.name)
    if (existsSync(path.join(candidate, "encodings"))) return candidate
  }
  return undefined
}

/**
 * The one link a newer bundle's interpreter needs, `<home>/lib/<interpreter name>`, and the home to point it at
 * (§4.4 解释器根修复). That interpreter does not find its own standard library and dies initialising the filesystem
 * encoding, before any user code runs, so the fix has to be a layout on disk (§4.3 principle 9).
 */
export function ensurePythonHome(interpreter: string, standardLibrary: string): string | undefined {
  // Lowercased: on a case-insensitive volume a hint written `.../Python3.12` names the same binary, and the link
  // has to take the lower-case name the interpreter looks for beneath its home.
  const name = path.basename(interpreter).toLowerCase()
  if (!/^python3\.\d+$/.test(name)) return undefined

  const home = path.join(Global.Path.cache, "geo", "qgis-pyhome")
  const lib = path.join(home, "lib")
  const link = path.join(lib, name)
  try {
    mkdirSync(lib, { recursive: true })
    const current = statLink(link)
    if (current) {
      if (current.isSymbolicLink() && path.resolve(lib, readlinkSync(link)) === path.resolve(standardLibrary)) {
        return home
      }
      unlinkSync(link)
    }
    symlinkSync(standardLibrary, link)
    return home
  } catch {
    // Best effort: without a home the probe fails at interpreter startup and its raw output says so.
    return undefined
  }
}

function statLink(target: string) {
  try {
    return lstatSync(target)
  } catch {
    return undefined
  }
}

export interface Assembly {
  readonly env: Record<string, string>
  readonly choices: Record<string, Choice>
}

/**
 * Resources are looked for in three layouts: directly under the resources directory as the older bundle keeps
 * them, one level deeper as the newer bundle nests them, and under the prefix as a package-manager install has them.
 */
export function assemble(prefix: string, interpreter: string): Assembly {
  const env: Record<string, string> = { QGIS_PREFIX_PATH: prefix }
  const resources = path.join(path.resolve(prefix, ".."), "Resources")
  const choices: Record<string, Choice> = {}

  const projectionCandidates = [
    path.join(resources, "proj"),
    path.join(resources, "qgis", "proj"),
    path.join(prefix, "share", "proj"),
  ]
  // Validate the payload, never the container (§4.3 principle 4).
  const projection = projectionCandidates.find(QgisPaths.hasProjectionDatabase)
  choices.projection = { selected: projection, candidates: projectionCandidates }
  if (projection) {
    // Both names for one directory: which one an install reads depends on the projection library version it bundles.
    env.PROJ_LIB = projection
    env.PROJ_DATA = projection
  }

  const gdalCandidates = [
    path.join(resources, "gdal"),
    path.join(resources, "qgis", "gdal"),
    path.join(prefix, "share", "gdal"),
  ]
  const gdal = QgisPaths.firstExisting(gdalCandidates)
  choices.gdalData = { selected: gdal, candidates: gdalCandidates }
  if (gdal) env.GDAL_DATA = gdal

  const standardLibrary = findStandardLibrary(resources)

  // A path list, so every existing candidate is collected rather than the first taken — coexisting is normal (§4.4).
  const moduleCandidates = [
    path.join(resources, "python"),
    path.join(resources, "qgis", "python"),
    standardLibrary ? path.join(standardLibrary, "site-packages") : undefined,
    path.join(prefix, "share", "qgis", "python"),
  ]
  const modulePaths: string[] = []
  for (const candidate of QgisPaths.allExisting(moduleCandidates)) {
    modulePaths.push(candidate)
    // The plugins directory carries the processing module, and QGIS adds it during its own initialisation — after
    // the algorithm framework needs it, so it goes on the path here (§4.5 overlay 2 applies to this track too).
    const plugins = path.join(candidate, "plugins")
    if (existsSync(plugins)) modulePaths.push(plugins)
  }
  choices.modulePath = { selected: modulePaths[0], candidates: QgisPaths.unique(moduleCandidates) }
  if (modulePaths.length > 0) {
    const inherited = process.env.PYTHONPATH
    env.PYTHONPATH = inherited ? [...modulePaths, inherited].join(":") : modulePaths.join(":")
  }

  if (standardLibrary) {
    const home = ensurePythonHome(interpreter, standardLibrary)
    choices.pythonHome = { selected: home, candidates: [standardLibrary] }
    if (home) env.PYTHONHOME = home
  }

  const qtPlugins = path.join(path.resolve(prefix, ".."), "PlugIns")
  if (existsSync(qtPlugins)) env.QT_PLUGIN_PATH = qtPlugins

  // Every assembly track sets these: the read scripts emit non-escaped structured text, so an encoding fault
  // corrupts the body and not just a diagnostic message (§4.13 constraint 2).
  env.PYTHONUTF8 = "1"
  env.PYTHONIOENCODING = "UTF-8"
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return { env, choices }
}
