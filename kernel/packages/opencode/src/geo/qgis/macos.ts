export * as QgisMacOS from "./macos"

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { QgisPaths } from "./paths"
import type { Choice } from "./types"

/* --- GeoCode: resolving a QGIS environment on macOS (docs/GEOKERNEL.md §4.4).
 *
 * Two install shapes, and within the app bundle two generations of layout that
 * differ in where the interpreter lives, where its standard library lives, and
 * whether the interpreter can start at all without help. --- */

/**
 * Does this executable directory belong to a QGIS install?
 *
 * Every application bundle has one, so without a marker any bundle at all
 * would be accepted as a QGIS prefix — a hint pointing into an unrelated
 * application would be taken at face value and fail much later, as a confusing
 * import error rather than a clean "this is not QGIS" (§4.4).
 */
export function isQgisBundle(executableDir: string): boolean {
  return existsSync(path.join(executableDir, "qgis_process")) || existsSync(path.join(executableDir, "QGIS"))
}

export interface PrefixResolution {
  readonly prefix?: string
  /** True when a bundle was found but carries no QGIS marker — a definite answer. */
  readonly notQgis: boolean
  /**
   * Where the executable directory WOULD be, kept alongside a not-qgis
   * verdict. The escape hatch needs it: when the hint itself is a real
   * interpreter, the marker's absence must not veto the probe (§4.3
   * principle 10 — lenient where recovery exists), and this is the prefix
   * that best-effort attempt runs under.
   */
  readonly fallbackPrefix?: string
  /**
   * True when the prefix passed a marker check (levels 1 and 2). The
   * non-bundle fallback never verifies anything, and the reachability precheck
   * must not treat its guess as evidence — that is the difference between
   * "found a QGIS install" and "derived some directory" (§4.3 可达性预检).
   */
  readonly verified: boolean
}

/**
 * Locate the installation prefix from a hint, which may be the interpreter, the
 * bundle, or anything nested inside it.
 *
 * Three levels, in order. The first two target application bundles and verify
 * the marker; the third is a best-effort for installs that are not bundles at
 * all — package managers, source builds — where there is no marker to check and
 * the probe is left to give the verdict.
 */
export function resolvePrefix(hint: string): PrefixResolution {
  // 1. The hint runs through a bundle's executable directory. Covers the
  //    canonical case where the hint IS the interpreter.
  // A marker hit here is a verified answer; a miss is NOT a verdict — the
  // design places marker verification in level 2's scan (§4.4), and level 1's
  // job is only to find the directory. The miss is remembered, falls through.
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

  // 2. The hint names a bundle, or something inside one that does not pass
  //    through the executable directory — the bundle root itself, a resource,
  //    anything nested.
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

  // 3. Not a bundle. Best effort for package-manager and source installs —
  // and explicitly unverified: there is no marker to check outside a bundle,
  // so the probe is the only judge (§4.4).
  return { prefix: path.resolve(hint, "../.."), notQgis: false, verified: false }
}

/**
 * Find the bundled interpreter under a prefix.
 *
 * Two generations: the older keeps it in an executable subdirectory under a
 * name with no version, the newer puts it at the prefix root with the minor
 * version in its name and no intermediate directory.
 */
export function findInterpreter(prefix: string): Choice {
  const candidates: string[] = []
  const legacy = path.join(prefix, "bin", "python3")
  if (existsSync(legacy)) candidates.push(legacy)
  for (const entry of QgisPaths.entries(prefix)) {
    // A versioned interpreter is a file, or a symlink to one — never a directory.
    if (entry.isDirectory()) continue
    if (/^python3\.\d+$/.test(entry.name)) candidates.push(path.join(prefix, entry.name))
  }
  return { selected: candidates[0], candidates }
}

/**
 * Find the standard library root inside the resources directory.
 *
 * Identified by CONTENT, not by name and not by type. Two independent reasons,
 * both confirmed on real installs:
 *
 * - Some bundles share a standard library between application variants through
 *   a symbolic link, and a type test reports "not a directory" for a link that
 *   points at one.
 * - **The directory's name need not match the interpreter's version.** A 3.44
 *   bundle was observed shipping a `python3.12` interpreter whose standard
 *   library sits in a directory named `python3.11`. Matching on the version
 *   number would find nothing at all.
 *
 * So: any directory named like a versioned Python that contains the encodings
 * module. That module is what the interpreter reaches for first, and its
 * absence is exactly what aborts startup.
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
 * Build the link structure the interpreter expects, and return its root.
 *
 * The newer bundle's interpreter cannot find its own standard library. The
 * binary carries a compiled-in prefix from the machine it was BUILT on — a
 * path that does not exist here — and the bundle's actual standard library sits
 * somewhere that prefix would never look. Startup aborts while initialising the
 * filesystem encoding, which is before any user code runs, so no environment
 * variable can rescue it and the fix has to be a real directory layout
 * (§4.3 principle 9).
 *
 * The structure is one link: `<home>/lib/<interpreter name>` pointing at the
 * standard library. **The name comes from the binary and the target comes from
 * content discovery, and neither assumes the other** — which is what makes it
 * work on the install where the two disagree.
 *
 * Only for versioned interpreter names: an unversioned one uses a different
 * search behaviour and does not hit this mismatch.
 */
export function ensurePythonHome(interpreter: string, standardLibrary: string): string | undefined {
  // Lowercased before matching, and the link takes the lowercased name:
  // the volume this runs on is case-insensitive by default, so a hint written
  // `.../Python3.12` names the same real binary — and CPython looks for
  // `lib/python3.X` in lower case regardless of how the file was spelled.
  const name = path.basename(interpreter).toLowerCase()
  if (!/^python3\.\d+$/.test(name)) return undefined

  const home = path.join(Global.Path.cache, "geo", "qgis-pyhome")
  const lib = path.join(home, "lib")
  const link = path.join(lib, name)
  try {
    mkdirSync(lib, { recursive: true })
    const current = statLink(link)
    if (current) {
      // Idempotent: keep a link that already points at the right place, replace
      // one that does not. A user who moves their install leaves no stale link.
      if (current.isSymbolicLink() && path.resolve(lib, readlinkSync(link)) === path.resolve(standardLibrary)) {
        return home
      }
      unlinkSync(link)
    }
    symlinkSync(standardLibrary, link)
    return home
  } catch {
    // Best effort. Without it the probe fails at interpreter startup and says so.
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
 * Assemble the environment for a resolved prefix.
 *
 * Resource candidates cover three layouts: the older bundle keeping them
 * directly under resources, the newer bundle nesting them one level deeper, and
 * a package-manager install using the conventional shared directory under the
 * prefix.
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
    // Both spellings: the newer library reads one, older versions the other,
    // and an install can pair a new QGIS with an older projection library.
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

  // A path LIST, so every existing candidate is collected rather than the first
  // one taken — several coexisting is the normal state (§4.4).
  const moduleCandidates = [
    path.join(resources, "python"),
    path.join(resources, "qgis", "python"),
    standardLibrary ? path.join(standardLibrary, "site-packages") : undefined,
    path.join(prefix, "share", "qgis", "python"),
  ]
  const modulePaths: string[] = []
  for (const candidate of QgisPaths.allExisting(moduleCandidates)) {
    modulePaths.push(candidate)
    // The plugins directory carries the processing module, and QGIS only adds
    // it during its own initialisation — which happens AFTER the algorithm
    // framework is initialised. Prepending it here is what lets that framework
    // come up at all (§4.5 overlay 2, and it applies here just as much).
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

  // Every assembly track sets these, without exception: the read scripts emit
  // non-escaped structured text so an encoding fault corrupts the BODY, not
  // just a diagnostic message (§4.13 constraint 2).
  env.PYTHONUTF8 = "1"
  env.PYTHONIOENCODING = "UTF-8"
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return { env, choices }
}
