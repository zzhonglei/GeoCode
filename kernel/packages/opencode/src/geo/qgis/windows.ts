export * as QgisWindows from "./windows"

import { existsSync, readdirSync } from "node:fs"
import nodePath from "node:path"
import { QgisPaths } from "./paths"
import type { Choice } from "./types"

/* --- GeoCode: resolving a QGIS environment on Windows (docs/GEOKERNEL.md §4.5).
 *
 * All string work goes through `path.win32`, never the platform module: on Windows the two are the same, and
 * everywhere else it keeps the segment scanning and the ranking testable. Hints may arrive with forward slashes;
 * win32 normalize folds them. Rules here that look arbitrary transcribe incidents. --- */

const win = nodePath.win32

/** The QGIS prefix variable is the one path QGIS parses expecting forward slashes; the rest stay native (§4.5). */
export function toQgisPath(value: string): string {
  return value.replace(/\\/g, "/")
}

export function toNativeSep(value: string): string {
  return value.replace(/\//g, "\\")
}

/**
 * The official launchers, long-term support first, then current, then development; an install carrying none of
 * them falls to the manual track (§4.5).
 */
export const LAUNCHER_NAMES = ["python-qgis-ltr.bat", "python-qgis.bat", "python-qgis-dev.bat"] as const

export function findLauncher(root: string): string | undefined {
  return QgisPaths.firstExisting(LAUNCHER_NAMES.map((name) => win.join(root, "bin", name)))
}

/**
 * The hint names a mid-layer directory of the install — the `<root>\apps\qgis-ltr` shape, carrying both a module
 * and an executable directory — so the root is two levels up. Shared by both tracks so they cannot disagree on
 * what "root" means, and it is what covers an install none of whose ancestors carries a launcher, which the
 * segment scan demands.
 */
export function correctMidLayer(hint: string): string | undefined {
  if (existsSync(win.join(hint, "python")) && existsSync(win.join(hint, "bin"))) {
    return win.resolve(hint, "../..")
  }
  return undefined
}

/**
 * The install root behind a hint pointing anywhere inside it: any segment containing "qgis" or "osgeo" — substring
 * only, no version format — whose prefix carries an official launcher. Every matching segment is tried and not
 * only the first, so a nested install is still found when the container above it matches but holds no launcher.
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
 * Both installer families put the bundled interpreter at `<root>\apps\Python<NNN>\python.exe`, so a hint that is
 * the interpreter yields the root even when no directory name carries a substring the segment scan looks for.
 */
export function rootFromInterpreter(hint: string): string | undefined {
  const appsDir = win.resolve(hint, "../..")
  if (win.basename(appsDir).toLowerCase() === "apps") return win.dirname(appsDir)
  return undefined
}

/**
 * By content, not by name (§4.3 principle 4): an ancestor holding an `apps` directory, or a launcher beside the
 * shim, is a root whatever it is called. It reaches the install renamed out of every substring and pointed at
 * through the root-level `bin\python3.exe` shim, where the remaining fallback would settle on `<root>\bin` and
 * assemble an environment out of an empty tree.
 */
export function findRootByContent(hint: string): string | undefined {
  let walking = win.resolve(hint)
  for (let depth = 0; depth < 8; depth++) {
    const parent = win.dirname(walking)
    if (parent === walking) return undefined
    walking = parent
    if (existsSync(win.join(walking, "apps"))) return walking
    if (LAUNCHER_NAMES.some((name) => existsSync(win.join(walking, "bin", name)))) return walking
  }
  return undefined
}

/** The bundled interpreter under a root, whatever Python version it ships. */
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
    // Unreadable mid-scan: the caller falls back to the hint, which the diagnostics then show verbatim.
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
 * A candidate must carry both the module and the executable directory (§4.3 principle 4) — a `qgis*` name proves
 * nothing — and the fixed order is what keeps the choice from drifting with directory enumeration order.
 */
export function resolveSubPrefix(root: string, interpreter: string, hint?: string): Choice {
  const candidates: (string | undefined)[] = []
  const interpreterApps = win.resolve(interpreter, "../..")
  if (win.basename(interpreterApps).toLowerCase() === "apps") {
    candidates.push(...qgisNamedSubdirectories(interpreterApps))
  }
  candidates.push(...qgisNamedSubdirectories(win.join(root, "apps")))
  candidates.push(win.join(root, "apps", "qgis-ltr"), win.join(root, "apps", "qgis"))

  // A hint that is itself a complete sub-prefix outranks the fixed order, which is only there to break ties the
  // user expressed no opinion about: pointing at `apps\qgis-dev` and getting the LTR install beside it answers a
  // question nobody asked (§4.5 子前缀选择尊重显式意图). Both directories are required of it too — the hint can be
  // the interpreter, and `candidates` travels to the user's diagnostics as a list of sub-prefixes.
  const resolvedHint = hint ? win.resolve(hint) : undefined
  const preferred =
    resolvedHint && existsSync(win.join(resolvedHint, "python")) && existsSync(win.join(resolvedHint, "bin"))
      ? resolvedHint
      : undefined
  if (preferred) candidates.push(preferred)
  const ordered = QgisPaths.unique(candidates).sort((a, b) => {
    const rank = (a === preferred ? -1 : subPrefixRank(a)) - (b === preferred ? -1 : subPrefixRank(b))
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
 * Newer Qt first, both case spellings of each, and the order is a necessity: newer QGIS links only the newer Qt,
 * so searching the old one alone leaves the Qt directory unregistered — which surfaces as a core-module import
 * failure that never mentions Qt (§4.5).
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
 * Every component's executable directory under `<root>\apps`, and the width is load-bearing (§4.3 principle 5):
 * registering any directory for dynamic-library search puts the interpreter in a restricted mode where cascade
 * loads resolve only against registered directories, and the core library's dependencies are spread across
 * components. Existence is filtered by the caller.
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

/** The conventional projection-data locations; this order is also their rank, which `projectionRank` reads off. */
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
 * Bounded search for projection data when no conventional candidate holds the database. Ties break on path length
 * and then lexically, so the same tree always yields the same directory (§4.3 principle 3).
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
  // Payload, not container (§4.3 principle 4): a proj directory without its database fails much later, on the
  // first custom coordinate system.
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

/** The manual track: replicate what the official launcher sets up, since we spawn the interpreter without it (§4.5). */
export function assembleManual(interpreter: string, root: string, hint?: string): ManualAssembly {
  const choices: Record<string, Choice> = {}

  const subPrefixChoice = resolveSubPrefix(root, interpreter, hint)
  const subPrefix = subPrefixChoice.selected ?? root
  choices.subPrefix = subPrefixChoice

  const qtRoot = findQtRoot(root)
  choices.qtRoot = {
    selected: qtRoot,
    candidates: ["qt6", "Qt6", "qt5", "Qt5"].map((name) => win.join(root, "apps", name)),
  }

  const env: Record<string, string> = {
    QGIS_PREFIX_PATH: toQgisPath(subPrefix),
    OSGEO4W_ROOT: root,
    PYTHONHOME: win.dirname(interpreter),
    GDAL_FILENAME_IS_UTF8: "YES",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "UTF-8",
    VSI_CACHE: "TRUE",
    VSI_CACHE_SIZE: "1000000",
  }

  // Both names for one directory: the projection library renamed its data variable, and which one an install reads
  // depends on the version it bundles (§4.5).
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
    env.PYTHONPATH = process.env.PYTHONPATH ? [...modulePaths, process.env.PYTHONPATH].join(";") : modulePaths.join(";")
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

  // The wide set, every component's bin — see componentBinDirs for why the narrow one is not enough.
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
 * One line and pure ASCII, both mandatory: the command interpreter's handling of multi-line and non-ASCII payloads
 * varies with the system language, and a mangled script here silently forces the manual fallback (§4.5). The
 * `dict()` is not decoration — `json.dumps` refuses `os.environ`, which is a mapping and not a dict.
 */
export const ENV_DUMP_SCRIPT = `import os,json,sys; sys.stdout.write('${ENV_DUMP_MARKER}'+json.dumps(dict(os.environ)))`

export interface BridgeAdoption {
  readonly env: Record<string, string>
  readonly prefix: string
  readonly interpreter: string
}

/**
 * Adopt a launcher's dumped environment whole (§4.5 track one, §4.3 principle 8): we know our own sensitive
 * variables but not the ones QGIS needs, so nothing is filtered before the display exit. `PATH` is checked because
 * this track registers no dynamic-library directories and rides entirely on it for cascade resolution, so an empty
 * one would pass the probe and fail in real execution.
 */
export function adoptBridgeDump(dumped: Record<string, string>, fallbackRoot: string): BridgeAdoption | undefined {
  if (!dumped.QGIS_PREFIX_PATH || !dumped.PYTHONHOME || !dumped.PATH) return undefined

  // The launcher is the authority on which interpreter ships with the install; the hint stops mattering here (§4.5).
  const interpreter = win.join(toNativeSep(dumped.PYTHONHOME), "python.exe")
  const prefix = dumped.QGIS_PREFIX_PATH ? toNativeSep(dumped.QGIS_PREFIX_PATH) : fallbackRoot

  const env = { ...dumped }

  // Overlay 2 of §4.5: the launcher exports only the module directory, and QGIS appends the plugins directory
  // during its own initialisation — after the algorithm framework needs it. Deduplicated case-insensitively,
  // because that is how Windows paths compare.
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

  // Overlay 1 of §4.5: the launcher serves interactive use and cannot know a program parses this output. Without
  // these, a non-English system encodes it in the system codepage while we decode UTF-8, and the read scripts emit
  // non-escaped structured text — so that corrupts the body, not just messages (§4.13 constraint 2).
  env.PYTHONUTF8 = "1"
  env.PYTHONIOENCODING = "UTF-8"
  env.GDAL_FILENAME_IS_UTF8 = "YES"

  return { env, prefix, interpreter }
}
