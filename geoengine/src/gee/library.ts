export * as Library from "./library.ts"

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Task and asset names: Earth Engine's own rule, with room for both in an export's description (see geocode/_run.py). */
export const NAME = /^[A-Za-z0-9_-]{1,30}$/

/** What GeoAgent is told of a name that breaks NAME. */
export const NAME_RULE = 'use 1 to 30 letters, digits, "_" or "-"'

/** The folder in the user's Earth Engine assets that GeoCode keeps its tasks in. */
export const FOLDER = "GeoCode"

/**
 * GeoCode's Python package, geoengine/python/geocode, as its files' texts by their paths under geoengine/python. The
 * run hands them to the Python, which imports the package from them: the app keeps the engine in its archive, where a
 * Python could not read the files. The build (script/build.ts) puts them in place of `globalThis.GEOCODE_PACKAGE`, as
 * they were when the engine was built; run from source, they are read here.
 */
export const FILES: Readonly<Record<string, string>> =
  (globalThis as { GEOCODE_PACKAGE?: Readonly<Record<string, string>> }).GEOCODE_PACKAGE ??
  read(fileURLToPath(new URL("../../python/", import.meta.url)))

/** The Python files under `root`, by their paths with "/" between the parts. */
export function read(root: string): Record<string, string> {
  const files = fs
    .readdirSync(root, { recursive: true, encoding: "utf-8" })
    .filter((file) => file.endsWith(".py"))
    .toSorted()
  return Object.fromEntries(
    files.map((file) => [file.split(path.sep).join("/"), fs.readFileSync(path.join(root, file), "utf-8")]),
  )
}
