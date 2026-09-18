export * as QgisBootstrap from "./bootstrap"

import path from "node:path"

/* --- GeoCode: DLL directory registration for QGIS subprocesses, Windows manual track only (docs/GEOKERNEL.md §4.5).
 * macOS and the bridge track pass an empty list, which leaves every input unchanged. --- */

export function preamble(dllDirectories: readonly string[]): string {
  if (dllDirectories.length === 0) return ""
  return ["import os", ...dllDirectories.map((dir) => `os.add_dll_directory(${JSON.stringify(dir)})`)].join("\n")
}

export function wrapInline(script: string, dllDirectories: readonly string[]): string {
  const bootstrap = preamble(dllDirectories)
  return bootstrap ? `${bootstrap}\n${script}` : script
}

/**
 * Rewritten as `-c` so the registration precedes the script's first import; argv, the script's directory first on
 * `sys.path` and `__main__` keep it indistinguishable from running the file directly.
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
