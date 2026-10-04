export * as Macos from "./macos.ts"

import fsp from "node:fs/promises"
import path from "node:path"

export interface Install {
  readonly app: string
  /** QGIS's own launcher for its interpreter, which sets the interpreter's home inside the bundle. */
  readonly interpreter: string
  readonly version: string | undefined
}

export type Located =
  | { readonly ok: true; readonly install: Install }
  | {
      readonly ok: false
      readonly status: "path-missing" | "not-qgis" | "unsupported"
      readonly message: string
      readonly app?: string
      readonly version?: string
    }

/** Finds the QGIS app bundle a configured path points at or into, and checks it has the layout this supports. */
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

  const interpreter = path.join(app, "Contents", "MacOS", "python")
  if (!(await exists(interpreter))) {
    return {
      ok: false,
      status: "unsupported",
      message: `${app} has no Contents/MacOS/python, the layout of QGIS 3.44 and 4.x; older releases are not supported`,
      app,
      version,
    }
  }
  return { ok: true, install: { app, interpreter, version } }
}

/** What a task adds to the engine's environment. */
export function environment(install: Install): Record<string, string> {
  const resources = path.join(install.app, "Contents", "Resources", "qgis")
  return {
    // QGIS's launcher sets only the interpreter's home; without these GDAL cannot find the projection database.
    PROJ_DATA: path.join(resources, "proj"),
    GDAL_DATA: path.join(resources, "gdal"),
    // Inherited from a login shell, it can put another Python's packages ahead of QGIS's own; Python ignores it empty.
    PYTHONPATH: "",
    PYTHONIOENCODING: "utf-8",
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
