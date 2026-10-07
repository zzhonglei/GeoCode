export * as Macos from "./macos.ts"

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Installs } from "./installs.ts"

export type Located =
  | { readonly ok: true; readonly install: Installs.Install }
  | {
      readonly ok: false
      readonly status: "path-missing" | "not-qgis" | "python-missing"
      readonly message: string
      readonly app?: string
      readonly version?: string
    }

/** Finds the QGIS app bundle a configured path points at or into, and QGIS's launcher for its Python inside it. */
export async function locate(configured: string): Promise<Located> {
  // A relative path in a configuration file is almost always a mistake, and would resolve against the engine's own
  // working directory.
  if (!path.isAbsolute(configured)) {
    return { ok: false, status: "path-missing", message: `${configured} is not an absolute path` }
  }
  const resolved = path.resolve(configured)
  // The outermost bundle: QGIS carries helper bundles of its own inside.
  const segments = resolved.split(path.sep)
  const index = segments.findIndex((segment) => segment.toLowerCase().endsWith(".app"))
  if (index < 0) {
    if (!(await exists(resolved))) return { ok: false, status: "path-missing", message: `${resolved} does not exist` }
    return { ok: false, status: "not-qgis", message: `${resolved} is not inside an app bundle` }
  }
  const app = segments.slice(0, index + 1).join(path.sep)
  if (!(await exists(app))) return { ok: false, status: "path-missing", message: `${app} does not exist`, app }

  const plist = await fsp.readFile(path.join(app, "Contents", "Info.plist"), "utf-8").catch(() => "")
  const identifier = plistString(plist, "CFBundleIdentifier")
  const version = plistString(plist, "CFBundleShortVersionString")
  if (!identifier?.startsWith("org.qgis.")) {
    return { ok: false, status: "not-qgis", message: `${app} is not a QGIS app bundle`, app }
  }

  // A launcher that sets the interpreter's home inside the bundle.
  const interpreter = path.join(app, "Contents", "MacOS", "python")
  if (!(await exists(interpreter))) {
    return {
      ok: false,
      status: "python-missing",
      message: `${app} has no Contents/MacOS/python to start its Python with`,
      app,
      version,
    }
  }
  return { ok: true, install: { app, interpreter, version } }
}

/** The Spotlight query for every QGIS, whatever its bundle is called or wherever it is. */
export const SPOTLIGHT_QUERY = "kMDItemCFBundleIdentifier == 'org.qgis.*'"

/** How GeoAgent finds QGIS on this computer, for setting it up itself. */
export const FINDING = `Find QGIS on this computer: QGIS apps are usually in /Applications or ~/Applications, and mdfind "${SPOTLIGHT_QUERY}" finds them anywhere. If there is more than one, ask the user which to use.`

/** How GeoAgent writes the path into machine.json, after "Its configuration is in <file>, ". */
export const CONFIGURED = 'as {"qgis": {"path": "<QGIS app>"}}.'

/** Why a QGIS without its launcher does not work, for GeoAgent. */
export const NO_PYTHON = "it has no Contents/MacOS/python to start its Python with"

/**
 * The QGIS apps in the application folders and those Spotlight found, newest first. One under /Volumes, on a disk
 * image or an external drive, is left out: it can be gone by the next start.
 */
export async function installs(
  spotlight: readonly string[],
  folders = ["/Applications", path.join(os.homedir(), "Applications")],
): Promise<Installs.Found[]> {
  const listed = await Promise.all(
    folders.map((folder) =>
      fsp.readdir(folder).then(
        (names) => names.filter((name) => name.toLowerCase().endsWith(".app")).map((name) => path.join(folder, name)),
        () => [],
      ),
    ),
  )
  const candidates = [...new Set([...listed.flat(), ...spotlight])].filter(
    (candidate) => path.isAbsolute(candidate) && !candidate.startsWith("/Volumes/") && !candidate.includes("/.Trash/"),
  )
  const found = new Map<string, Installs.Found>()
  for (const located of await Promise.all(candidates.map(locate))) {
    const entry = foundOf(located)
    if (!entry) continue
    // A symlinked bundle and its target are one install; the folder listing, which comes first, names it.
    const key = await fsp.realpath(entry.app).catch(() => entry.app)
    if (!found.has(key)) found.set(key, entry)
  }
  return Installs.newestFirst([...found.values()])
}

function foundOf(located: Located): Installs.Found | undefined {
  if (located.ok) return { app: located.install.app, version: located.install.version }
  if (located.status === "python-missing" && located.app) return { app: located.app, version: located.version }
  return undefined
}

/** What a task adds to the engine's environment. */
export function environment(install: Installs.Install): Record<string, string> {
  const resources = path.join(install.app, "Contents", "Resources", "qgis")
  return {
    // QGIS's launcher sets only the interpreter's home; without these GDAL cannot find the projection database.
    PROJ_DATA: path.join(resources, "proj"),
    GDAL_DATA: path.join(resources, "gdal"),
    // Inherited from a login shell, it can put another Python's packages ahead of QGIS's own; Python ignores it empty.
    PYTHONPATH: "",
    PYTHONIOENCODING: "utf-8",
    // Off: Qt's own diagnostics, which a run would pass on with what QGIS, GDAL and PROJ write.
    QT_LOGGING_RULES: "qt.*=false",
  }
}

async function exists(target: string) {
  return fsp.stat(target).then(
    () => true,
    () => false,
  )
}

/** Enough for the XML property lists app bundles carry; a binary one reads as having no value. */
function plistString(plist: string, key: string) {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))
  return match?.[1]
}
