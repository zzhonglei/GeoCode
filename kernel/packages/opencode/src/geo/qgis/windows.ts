export * as QgisWindows from "./windows"

import { existsSync, readdirSync } from "node:fs"
import nodePath from "node:path"
import { QgisPaths } from "./paths"
import type { Choice } from "./types"

/* --- GeoCode: resolving a QGIS environment on Windows (docs/GEOKERNEL.md §4.5).
 *
 * This file is a transcription of behaviour that took repeated real-machine
 * failures to get right. Where a rule looks arbitrary, its incident is in the
 * comment; none of them are guesses. The Windows machine work is deferred, not
 * the coding (P7) — so every porting decision here errs toward the old code.
 *
 * All string work goes through `path.win32`, never the platform module: at
 * runtime on Windows the two are the same, and everywhere else it keeps the
 * pure logic — segment scanning, ranking — testable. Hints may arrive with
 * forward slashes (JSON configs often do); win32 normalize folds them. --- */

const win = nodePath.win32

/** QGIS parses its prefix variable expecting forward slashes — the official
 * launcher does the same rewrite. ONLY that variable: everything else stays on
 * native backslashes so command interpreters and Windows APIs behave. */
export function toQgisPath(value: string): string {
  return value.replace(/\\/g, "/")
}

export function toNativeSep(value: string): string {
  return value.replace(/\//g, "\\")
}

/**
 * The official launcher scripts, most stable variant first: long-term support,
 * then current, then development. Present on nearly every install; a minimal
 * install without them falls to the manual track.
 */
export const LAUNCHER_NAMES = ["python-qgis-ltr.bat", "python-qgis.bat", "python-qgis-dev.bat"] as const

export function findLauncher(root: string): string | undefined {
  return QgisPaths.firstExisting(LAUNCHER_NAMES.map((name) => win.join(root, "bin", name)))
}

/**
 * Mid-layer correction: the hint names a directory INSIDE the install that
 * carries both a module directory and an executable directory — the shape of
 * `<root>\apps\qgis-ltr` — so the real root is two levels up.
 *
 * Shared by both tracks so they cannot disagree on what "root" means. Its
 * coverage does not overlap the segment scan: a layout whose outer directories
 * carry no launcher (the install IS the sub-prefix's grandparent, nothing
 * above it qualifies) is reachable only through this correction.
 */
export function correctMidLayer(hint: string): string | undefined {
  if (existsSync(win.join(hint, "python")) && existsSync(win.join(hint, "bin"))) {
    return win.resolve(hint, "../..")
  }
  return undefined
}

/**
 * Find the install root from a hint that may point anywhere inside it.
 *
 * Scans path SEGMENTS left to right and accepts any segment whose name
 * contains "qgis" or "osgeo" — substring only, no version format, no separator
 * convention — requiring the prefix ending there to carry an official
 * launcher. Trying every matching segment (not just the first) handles nested
 * layouts where an outer container also matches but only the inner install
 * carries the launcher.
 *
 * A pure string scan: filesystem calls proportional to MATCHING segments, not
 * path depth. That is also a free defence — a stray launcher-named wrapper
 * script under some unrelated directory cannot pose as a root, because no
 * ancestor of it matches the substring.
 *
 * The documented trade-off stands: an install renamed to carry neither
 * substring is reachable only by pointing the hint at the interpreter itself,
 * which the manual track accepts without this lookup.
 */
export function findRootFromHint(hint: string): string | undefined {
  const normalized = win.normalize(hint)
  let start = 0
  for (let index = 0; index <= normalized.length; index++) {
    if (index !== normalized.length && normalized[index] !== win.sep) continue
    const segment = normalized.slice(start, index)
    if (/qgis|osgeo/i.test(segment)) {
      const candidate = normalized.slice(0, index)
      if (findLauncher(candidate)) return candidate
    }
    start = index + 1
  }
  return undefined
}

/**
 * Derive a root from an interpreter-shaped hint: both installer families put
 * the bundled interpreter at `<root>\apps\Python<NNN>\python.exe`.
 *
 * This is the escape hatch the segment scan's trade-off leaves open — a
 * renamed install found neither by substring nor by mid-layer shape resolves
 * here, provided the hint is the interpreter itself.
 */
export function rootFromInterpreter(hint: string): string | undefined {
  const appsDir = win.resolve(hint, "../..")
  if (win.basename(appsDir).toLowerCase() === "apps") return win.dirname(appsDir)
  return undefined
}

/** Find the bundled interpreter under a root, whatever Python version it ships. */
export function findInterpreterUnderRoot(root: string): string | undefined {
  const appsDir = win.join(root, "apps")
  if (!existsSync(appsDir)) return undefined
  try {
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/^python\d+$/i.test(entry.name)) continue
      const candidate = win.join(appsDir, entry.name, "python.exe")
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Unreadable mid-scan; the caller falls back to the hint and the probe
    // shows that hint verbatim in its diagnostics.
  }
  return undefined
}

/** Deterministic preference among coexisting sub-prefixes (§4.3 principle 3). */
export function subPrefixRank(prefix: string): number {
  const name = win.basename(prefix).toLowerCase()
  if (name === "qgis-ltr") return 0
  if (name === "qgis") return 1
  if (name === "qgis-dev") return 2
  if (name.startsWith("qgis-ltr")) return 3
  if (name.startsWith("qgis")) return 4
  return 20
}

/**
 * Enumerate QGIS sub-prefix candidates and pick by fixed order.
 *
 * A candidate must carry BOTH the module directory and the executable
 * directory (§4.3 principle 4) — a bare `qgis*` directory name proves nothing.
 * Taking "first found" instead of ranking would let the choice drift with
 * directory enumeration order between runs on the same machine.
 */
export function resolveSubPrefix(root: string, interpreter: string): Choice {
  const candidates: (string | undefined)[] = []
  const interpreterApps = win.resolve(interpreter, "../..")
  if (win.basename(interpreterApps).toLowerCase() === "apps") {
    candidates.push(...qgisNamedSubdirectories(interpreterApps))
  }
  candidates.push(...qgisNamedSubdirectories(win.join(root, "apps")))
  candidates.push(win.join(root, "apps", "qgis-ltr"), win.join(root, "apps", "qgis"))

  const ordered = QgisPaths.unique(candidates).sort((a, b) => {
    const rank = subPrefixRank(a) - subPrefixRank(b)
    return rank !== 0 ? rank : a.localeCompare(b)
  })
  const complete = ordered.filter(
    (candidate) => existsSync(win.join(candidate, "python")) && existsSync(win.join(candidate, "bin")),
  )
  return { selected: complete[0], candidates: ordered }
}

function qgisNamedSubdirectories(appsDir: string): string[] {
  if (!existsSync(appsDir)) return []
  try {
    return readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("qgis"))
      .map((entry) => win.join(appsDir, entry.name))
  } catch {
    return []
  }
}

/**
 * The Qt component root. Newer Qt FIRST, both case spellings of each — and the
 * order is a necessity, not a preference: newer QGIS links only the newer Qt,
 * and searching the old one alone leaves the Qt directory unregistered, which
 * surfaces as a core-module import failure with no mention of Qt at all
 * (§4.5).
 */
export function findQtRoot(root: string): string | undefined {
  return QgisPaths.firstExisting([
    win.join(root, "apps", "qt6"),
    win.join(root, "apps", "Qt6"),
    win.join(root, "apps", "qt5"),
    win.join(root, "apps", "Qt5"),
  ])
}

/**
 * Every component's executable directory under `<root>\apps`.
 *
 * The WIDTH of this set is load-bearing (§4.3 principle 5): once any directory
 * is registered for dynamic-library search, the interpreter switches to a
 * restricted mode where cascade loads — the core library pulling in its own
 * dependencies — resolve ONLY against registered directories. The narrow set
 * (root, Qt, sub-prefix) worked on one QGIS generation and broke on the next,
 * where the core library grew cross-component dependencies: launcher-started
 * interpreters imported fine while our spawn failed at the native core import.
 * Every component directory goes in, existing-or-not filtered by the caller.
 */
export function componentBinDirs(root: string): string[] {
  const appsDir = win.join(root, "apps")
  if (!existsSync(appsDir)) return []
  try {
    return readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => win.join(appsDir, entry.name, "bin"))
  } catch {
    return []
  }
}

/** The conventional projection-data locations, most specific first. */
export function projectionCandidates(root: string, subPrefix: string): string[] {
  return QgisPaths.unique([
    win.join(root, "share", "proj"),
    win.join(subPrefix, "resources", "proj"),
    win.join(root, "apps", "proj", "share", "proj"),
    win.join(root, "apps", "qgis-ltr", "resources", "proj"),
    win.join(root, "apps", "qgis", "resources", "proj"),
    win.join(root, "Library", "share", "proj"),
  ])
}

/** Rank a projection directory: known candidates by position, then by location pattern. */
export function projectionRank(dir: string, root: string, subPrefix: string): number {
  const normalized = win.normalize(dir).toLowerCase()
  const exact = projectionCandidates(root, subPrefix)
    .map((candidate) => win.normalize(candidate).toLowerCase())
    .indexOf(normalized)
  if (exact >= 0) return exact

  const portable = normalized.split(win.sep).join("/")
  if (portable.includes("/apps/proj/share/proj")) return 20
  if (portable.endsWith("/share/proj")) return 21
  if (portable.includes("/resources/proj")) return 22
  if (portable.includes("/library/share/proj")) return 23
  return 100
}

/**
 * Bounded search for projection data when no conventional candidate holds the
 * database. Depth-limited, skips cache and third-party package directories,
 * never follows directory symlinks. Results ranked by location pattern, ties
 * broken by path length then lexically — the same run on the same machine
 * always picks the same directory (§4.3 principle 3).
 */
export function searchProjectionDirs(root: string, subPrefix: string): string[] {
  const found: string[] = []
  const pending: { dir: string; depth: number }[] = [{ dir: win.resolve(root), depth: 0 }]
  const maxDepth = 8
  const skip = new Set(["__pycache__", "site-packages", "node_modules"])

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    if (QgisPaths.hasProjectionDatabase(current.dir)) found.push(current.dir)
    if (current.depth >= maxDepth) continue
    try {
      pending.push(
        ...readdirSync(current.dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !skip.has(entry.name.toLowerCase()))
          .map((entry) => ({ dir: win.join(current.dir, entry.name), depth: current.depth + 1 })),
      )
    } catch {
      continue
    }
  }

  return QgisPaths.unique(found).sort((a, b) => {
    const rank = projectionRank(a, root, subPrefix) - projectionRank(b, root, subPrefix)
    if (rank !== 0) return rank
    return a.length - b.length || a.localeCompare(b)
  })
}

export function findProjectionDir(root: string, subPrefix: string): Choice {
  const candidates = projectionCandidates(root, subPrefix)
  // Payload validation, not container existence (§4.3 principle 4): a proj
  // directory without its database fails much later, on the first custom CRS.
  const conventional = candidates.find(QgisPaths.hasProjectionDatabase)
  if (conventional) return { selected: conventional, candidates }
  const searched = searchProjectionDirs(root, subPrefix)
  return { selected: searched[0], candidates: QgisPaths.unique([...candidates, ...searched]) }
}

export interface ManualAssembly {
  readonly env: Record<string, string>
  readonly prefix: string
  readonly dllDirectories: string[]
  readonly choices: Record<string, Choice>
}

/**
 * The manual track: replicate everything the official launcher sets up,
 * because we spawn the interpreter directly without it (§4.5 track two).
 */
export function assembleManual(interpreter: string, root: string): ManualAssembly {
  const choices: Record<string, Choice> = {}

  const subPrefixChoice = resolveSubPrefix(root, interpreter)
  const subPrefix = subPrefixChoice.selected ?? root
  choices.subPrefix = subPrefixChoice

  const qtRoot = findQtRoot(root)
  choices.qtRoot = {
    selected: qtRoot,
    candidates: ["qt6", "Qt6", "qt5", "Qt5"].map((name) => win.join(root, "apps", name)),
  }

  const env: Record<string, string> = {
    // Forward slashes for THIS variable only — QGIS's own parsing prefers
    // them and the official launcher performs the same rewrite.
    QGIS_PREFIX_PATH: toQgisPath(subPrefix),
    // The canonical anchor variable both official setup scripts export.
    // Several QGIS internals and plugin helpers read it directly to locate
    // bundled tools; setting it defensively keeps them from key-erroring
    // under our spawn even when nothing in our own probe touches that code.
    OSGEO4W_ROOT: root,
    // The official launcher does not set an interpreter home, but bundled
    // runtimes observed in the wild do. Anchoring it at the interpreter's own
    // directory gives startup a deterministic home and avoids filesystem-
    // encoding init failures on some machines.
    PYTHONHOME: win.dirname(interpreter),
    GDAL_FILENAME_IS_UTF8: "YES",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "UTF-8",
    VSI_CACHE: "TRUE",
    VSI_CACHE_SIZE: "1000000",
  }

  // Both names, same directory: the projection library renamed its data
  // variable, and which one an install reads depends on the library version it
  // bundles. Writing one of them is the version-specific bet §4.5 forbids.
  const projection = findProjectionDir(root, subPrefix)
  choices.projection = projection
  if (projection.selected) {
    env.PROJ_LIB = projection.selected
    env.PROJ_DATA = projection.selected
  }

  const gdalData = QgisPaths.firstExisting([
    win.join(root, "apps", "gdal", "share", "gdal"),
    win.join(root, "share", "gdal"),
  ])
  if (gdalData) env.GDAL_DATA = gdalData

  const gdalDrivers = win.join(root, "apps", "gdal", "lib", "gdalplugins")
  if (existsSync(gdalDrivers)) env.GDAL_DRIVER_PATH = gdalDrivers

  const moduleRoot = win.join(subPrefix, "python")
  const modulePaths = QgisPaths.allExisting([moduleRoot, win.join(moduleRoot, "plugins")])
  if (modulePaths.length > 0) {
    env.PYTHONPATH = process.env.PYTHONPATH
      ? [...modulePaths, process.env.PYTHONPATH].join(";")
      : modulePaths.join(";")
  }

  const qtPlugins = QgisPaths.allExisting([
    win.join(subPrefix, "qtplugins"),
    qtRoot ? win.join(qtRoot, "plugins") : undefined,
  ])
  if (qtPlugins.length > 0) env.QT_PLUGIN_PATH = qtPlugins.join(";")

  const pathEntries = QgisPaths.allExisting([
    win.join(subPrefix, "bin"),
    qtRoot ? win.join(qtRoot, "bin") : undefined,
    win.join(win.dirname(interpreter), "Scripts"),
    win.join(root, "bin"),
  ])
  env.PATH = process.env.PATH ? [...pathEntries, process.env.PATH].join(";") : pathEntries.join(";")

  // The wide set — every component's bin — not the narrow one. See
  // componentBinDirs for the incident that made this width mandatory.
  const dllDirectories = QgisPaths.allExisting([
    win.join(root, "bin"),
    ...componentBinDirs(root),
    qtRoot ? win.join(qtRoot, "bin") : undefined,
    win.join(subPrefix, "bin"),
  ])

  return { env, prefix: subPrefix, dllDirectories, choices }
}

/** Marker for the bridge's environment dump. */
export const ENV_DUMP_MARKER = "__GEOCODE_ENV_JSON__"

/**
 * The one-liner the launcher runs to dump its assembled environment.
 *
 * Single line and pure ASCII, both mandatory: the command interpreter's
 * handling of multi-line and non-ASCII payloads varies with the system
 * language (observed corrupting on a Chinese-codepage machine), and a mangled
 * script here silently forces the manual fallback. The dict() copy is required
 * because the environ mapping is not directly serialisable on some builds.
 */
export const ENV_DUMP_SCRIPT = `import os,json,sys; sys.stdout.write('${ENV_DUMP_MARKER}'+json.dumps(dict(os.environ)))`

export interface BridgeAdoption {
  readonly env: Record<string, string>
  readonly prefix: string
  readonly interpreter: string
}

/**
 * Adopt a launcher's dumped environment (§4.5 track one).
 *
 * Sanity-checks the three keys a real launcher always exports before adopting.
 * The executable search path is the one that must not be waved through: this
 * track registers NO dynamic-library directories and relies entirely on that
 * path for cascade resolution, so with it empty the probe would pass while
 * real execution failed.
 *
 * Adopted COMPLETE, not filtered (§4.3 principle 8): we know our own sensitive
 * variables and exclude them at the display exit, but cannot enumerate which
 * variables QGIS needs. The old build filtered here with a keep-list and got
 * away with it only because the host environment was re-inherited underneath —
 * any launcher modification to an unlisted variable was silently lost.
 */
export function adoptBridgeDump(dumped: Record<string, string>, fallbackRoot: string): BridgeAdoption | undefined {
  if (!dumped.QGIS_PREFIX_PATH || !dumped.PYTHONHOME || !dumped.PATH) return undefined

  // The launcher is the authority on which interpreter ships with the install
  // (§4.5): the hint located the install, and stops mattering here.
  const interpreter = win.join(toNativeSep(dumped.PYTHONHOME), "python.exe")
  const prefix = dumped.QGIS_PREFIX_PATH ? toNativeSep(dumped.QGIS_PREFIX_PATH) : fallbackRoot

  const env = { ...dumped }

  // Overlay 2 of §4.5: the launcher's module path carries only the module
  // directory, with the plugins directory appended by QGIS during its OWN
  // initialisation — which runs after the algorithm framework would need it.
  // Observed as the framework failing to come up under the bridge on one QGIS
  // series while the manual track (which always prepended) worked. Prepend,
  // deduplicated case-insensitively because Windows paths compare that way.
  const plugins = win.join(prefix, "python", "plugins")
  if (existsSync(plugins)) {
    const existing = env.PYTHONPATH ?? ""
    const already = existing
      .toLowerCase()
      .split(";")
      .map((entry) => entry.trim())
      .includes(plugins.toLowerCase())
    if (!already) env.PYTHONPATH = existing ? `${plugins};${existing}` : plugins
  }

  // Overlay 1 of §4.5: the launcher serves interactive use and cannot know a
  // program will parse this interpreter's output. Without these, output on a
  // non-English system encodes in the system codepage while we decode UTF-8 —
  // and the read scripts emit non-escaped structured text, so that corrupts
  // the body, not just messages (§4.13).
  env.PYTHONUTF8 = "1"
  env.PYTHONIOENCODING = "UTF-8"
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return { env, prefix, interpreter }
}
