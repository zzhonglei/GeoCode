export * as QgisBootstrap from "./bootstrap"

import path from "node:path"

/* --- GeoCode: dynamic-library bootstrap for QGIS subprocesses
 * (docs/GEOKERNEL.md §4.5).
 *
 * Windows-manual-track only, and by construction: macOS and the bridge track
 * hand over an empty directory list, and every function here is a no-op on an
 * empty list. The registration HAS to happen inside the interpreter, before
 * the first QGIS import — the module loader consults the registered
 * directories at import time, so setting them any later is setting them
 * never. --- */

/** Python preamble registering each directory for dynamic-library search. */
export function preamble(dllDirectories: readonly string[]): string {
  if (dllDirectories.length === 0) return ""
  return ["import os", ...dllDirectories.map((dir) => `os.add_dll_directory(${JSON.stringify(dir)})`)].join("\n")
}

/** Prepend the bootstrap to an inline script. Identity when there is nothing to register. */
export function wrapInline(script: string, dllDirectories: readonly string[]): string {
  const bootstrap = preamble(dllDirectories)
  return bootstrap ? `${bootstrap}\n${script}` : script
}

/**
 * Rewrite a script-file invocation as an equivalent inline one, bootstrap first.
 *
 * Running the file directly would put the target's first import ahead of our
 * registration. The rewrite preserves direct-execution semantics — the script
 * runs as the main module, sees its own absolute path first in argv, and has
 * its directory at the front of the module search path — so scripts cannot
 * tell the difference (§4.5).
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
