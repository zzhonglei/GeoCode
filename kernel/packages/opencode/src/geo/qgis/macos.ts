export * as QgisMacOS from "./macos"

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { QgisPaths } from "./paths"
import type { Choice } from "./types"

/* --- GeoCode: resolving a QGIS environment on macOS, where app bundles come in two layout generations
 * (docs/GEOKERNEL.md §4.4). --- */

/** Every bundle has an executable directory, so without a marker an unrelated application passes as a prefix. */
export function isQgisBundle(executableDir: string): boolean {
  return existsSync(path.join(executableDir, "qgis_process")) || existsSync(path.join(executableDir, "QGIS"))
}

export interface PrefixResolution {
  readonly prefix?: string
  /**
   * The hint runs through a bundle carrying no QGIS marker. Read off the path's shape, so a bundle that is not on disk
   * at all also produces it.
   */
  readonly notQgis: boolean
  /** Kept with a not-qgis verdict, so `resolve.ts` can still probe a hint that is a real interpreter. */
  readonly fallbackPrefix?: string
  /**
   * True only after a marker check. The reachability precheck refuses level 3's answer on this flag; without it a
   * hint naming nothing at all would pass and come back as a probe spawn error.
   */
  readonly verified: boolean
}

export function resolvePrefix(hint: string): PrefixResolution {
  // Level 1: up through a bundle's executable directory. A marker miss is not a verdict; level 2 still gets a turn.
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

  // Level 3: package-manager and source installs, unverified because there is no marker outside a bundle.
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
 * By content: the version in the directory name need not match the interpreter's, and the entry need not be a
 * directory, since some bundles share the library through a symlink.
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
 * Links `<home>/lib/<interpreter name>` to the standard library and returns the home. A newer bundle's interpreter
 * dies initialising the filesystem encoding without it, before any user code runs, so the fix has to be on disk.
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
  const projection = projectionCandidates.find(QgisPaths.hasProjectionDatabase)
  choices.projection = { selected: projection, candidates: projectionCandidates }
  if (projection) {
    // Both names: which one is read depends on the projection library version the install bundles.
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

  // Every existing candidate rather than the first: several coexisting is normal.
  const moduleCandidates = [
    path.join(resources, "python"),
    path.join(resources, "qgis", "python"),
    standardLibrary ? path.join(standardLibrary, "site-packages") : undefined,
    path.join(prefix, "share", "qgis", "python"),
  ]
  const modulePaths: string[] = []
  for (const candidate of QgisPaths.allExisting(moduleCandidates)) {
    modulePaths.push(candidate)
    // The plugins directory carries processing, and QGIS adds it only during its own initialisation, after the
    // algorithm framework needs it.
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

  // Every assembly track must set these: the read scripts emit unescaped text, so an encoding fault corrupts the
  // payload and not just a diagnostic message (§4.13).
  env.PYTHONUTF8 = "1"
  env.PYTHONIOENCODING = "UTF-8"
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return { env, choices }
}
