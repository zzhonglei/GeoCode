export * as Geocodekit from "./geocodekit.ts"

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The package's name, as scripts import it and as its dist-info names it. */
export const NAME = "geocodekit"

export interface Package {
  /** GeoCode's version number, the package's version (docs/GEOCODEKIT.md, section 6). */
  readonly version: string
  /** The package's files' texts, by their paths under geoengine/python with "/" between the parts. */
  readonly files: Readonly<Record<string, string>>
}

/**
 * GeoCode's Python package as GeoEngine installs it into the base environment (docs/GEOCODEKIT.md, section 6). The
 * build (script/build.ts) puts it in place of `globalThis.GEOCODEKIT`, as it was when the engine was built: the app
 * keeps the engine in its archive, where nothing could read the package's files; run from source, it is read here.
 */
export const PACKAGE: Package =
  (globalThis as { GEOCODEKIT?: Package }).GEOCODEKIT ?? read(fileURLToPath(new URL("../../", import.meta.url)))

/**
 * The package's Python files and the JSON data they read under `geoengine`, and GeoCode's version number from the
 * app's package.json, where it is written alone (docs/DESKTOP.md, section 6).
 */
export function read(geoengine: string): Package {
  const root = path.join(geoengine, "python")
  const files = fs
    .readdirSync(path.join(root, NAME), { recursive: true, encoding: "utf-8" })
    .filter((file) => file.endsWith(".py") || file.endsWith(".json"))
    .map((file) => [NAME, ...file.split(path.sep)].join("/"))
    .toSorted()
  const app = path.join(geoengine, "..", "desktop", "packages", "electron", "package.json")
  const version = (JSON.parse(fs.readFileSync(app, "utf-8")) as { build: { extraMetadata: { version: string } } }).build
    .extraMetadata.version
  return {
    version,
    files: Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf-8")])),
  }
}
