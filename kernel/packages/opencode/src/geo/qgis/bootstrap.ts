export * as QgisBootstrap from "./bootstrap"

import path from "node:path"

/* --- GeoCode: dynamic-library bootstrap for QGIS subprocesses (docs/GEOKERNEL.md §4.5).
 *
 * Windows manual track only, by construction: macOS and the bridge track hand over an empty directory list, and
 * every function here leaves its input alone on one. Registration runs inside the interpreter because it must take
 * effect before the target's first import. --- */

export function preamble(dllDirectories: readonly string[]): string {
  if (dllDirectories.length === 0) return ""
  return ["import os", ...dllDirectories.map((dir) => `os.add_dll_directory(${JSON.stringify(dir)})`)].join("\n")
}

export function wrapInline(script: string, dllDirectories: readonly string[]): string {
  const bootstrap = preamble(dllDirectories)
  return bootstrap ? `${bootstrap}\n${script}` : script
}

/**
 * Running the file directly would put its first import ahead of the registration, so it is rewritten as an inline
 * one. Argv, the script's own directory at the front of the module search path, and `__main__` are what make the
 * rewrite indistinguishable from direct execution (§4.5).
 */
export function wrapScript(scriptPath: string, args: readonly string[], dllDirectories: readonly string[]): string[] {
  if (dllDirectories.length === 0) return [scriptPath, ...args]
  const absolute = path.resolve(scriptPath)
  const argv = JSON.stringify([absolute, ...args])
  return [
    "-c",
    `${preamble(dllDirectories)}\nimport os, runpy, sys\nsys.argv = ${argv}\nsys.path.insert(0, os.path.dirname(${JSON.stringify(absolute)}))\nrunpy.run_path(${JSON.stringify(absolute)}, run_name="__main__")`,
  ]
}
