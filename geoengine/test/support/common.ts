import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** geocodekit's source, which the tests' Python imports in place of the package installed in the base environment. */
export const SOURCE = fileURLToPath(new URL("../../python/", import.meta.url))

export const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The real interpreter behind `python3`, to stand in for GeoCode's own; none skips the tests that need one. */
export const python3 = (() => {
  if (process.platform === "win32") return
  try {
    return (
      execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim() || undefined
    )
  } catch {
    return
  }
})()

/**
 * An interpreter at `file` that runs `python` with `paths` first on its path. Isolated as GeoEngine runs it, Python
 * ignores PYTHONPATH, so they are put there by a line before the program it reads from standard input, as GeoEngine
 * gives every program. Its bytecode goes to one folder of the temporary directory, which the tests of a run share:
 * the package's own folder is not the tests' to write in.
 */
export const pythonWith = async (file: string, python: string, paths: readonly string[]) => {
  const cache = path.join(os.tmpdir(), "geoengine-pycache")
  const preamble = `import sys; sys.pycache_prefix = ${JSON.stringify(cache)}; sys.path[:0] = ${JSON.stringify(paths)}`
  await fs.writeFile(file, `#!/bin/sh\n{ echo '${preamble}'; cat; } | '${python}' "$@"\n`)
  await fs.chmod(file, 0o755)
  return file
}
