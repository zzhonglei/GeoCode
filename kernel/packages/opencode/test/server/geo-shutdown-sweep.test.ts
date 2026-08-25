import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/* Geographic processes go down with the server (docs/GEOKERNEL.md §10.1 #8b).
 *
 * Out of process because the fact under test is Node's default handling of
 * SIGTERM: it terminates without running the `exit` listener that is the
 * Runtime module's own last line of defence. */

const TOOLS = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem", "ogrinfo", "ogr2ogr"]
const ROOT = path.join(import.meta.dir, "..", "..")

const it = process.platform === "win32" ? test.skip : test

/** Derived from this pid, so a parallel suite is unlikely to pick the same port. */
const PORT = 20000 + (process.pid % 10000)

function toolchain(directory: string, pidFile: string) {
  fs.mkdirSync(directory, { recursive: true })
  for (const tool of TOOLS) {
    const script = path.join(directory, tool)
    // `exec` replaces the shell, so the recorded pid IS the surviving process.
    fs.writeFileSync(script, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 400\n`)
    fs.chmodSync(script, 0o755)
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (condition: () => boolean, ms: number) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(100)
  }
  return condition()
}

describe("geo shutdown sweep", () => {
  it("a running geographic process does not outlive the server that started it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "geo-sweep-"))
    const project = path.join(home, "project")
    const pidFile = path.join(home, "child.pid")
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, "scene.tif"), "pixels")
    toolchain(path.join(home, "bin"), pidFile)
    fs.mkdirSync(path.join(home, "config", "geocode"), { recursive: true })
    fs.writeFileSync(
      path.join(home, "config", "geocode", "machine.json"),
      JSON.stringify({ gdal: path.join(home, "bin") }),
    )

    const server = Bun.spawn(["bun", "run", "src/index.ts", "serve", "--port", String(PORT)], {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      },
      // Not piped: nothing reads them, and a full pipe buffer would stall the server mid-boot.
      stdout: "ignore",
      stderr: "ignore",
    })

    // `fetch` has no timeout of its own, so a server that accepts the connection and then stalls
    // would hang this call and the loop below would never reach its deadline check.
    const reachable = async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}/geo/status`, { signal: AbortSignal.timeout(2_000) })
        return true
      } catch {
        return false
      }
    }

    try {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !(await reachable())) await Bun.sleep(250)
      expect(await reachable()).toBe(true)

      // Meant to hang — the fake toolchain never returns — and awaited at the end, so it needs
      // a bound of its own.
      const ask = fetch(`http://127.0.0.1:${PORT}/geo/raster/meta?path=scene.tif&directory=${project}`, {
        signal: AbortSignal.timeout(60_000),
      }).catch(() => undefined)
      await waitFor(() => fs.existsSync(pidFile), 30_000)
      expect(fs.existsSync(pidFile)).toBe(true)

      const child = Number(fs.readFileSync(pidFile, "utf8").trim())
      expect(alive(child)).toBe(true)

      server.kill("SIGTERM")
      await waitFor(() => !alive(child), 15_000)
      expect(alive(child)).toBe(false)
      await ask
    } finally {
      server.kill("SIGKILL")
      const recorded = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : 0
      if (recorded && alive(recorded)) process.kill(recorded, "SIGKILL")
      fs.rmSync(home, { recursive: true, force: true })
    }
    // The three waits above budget 60 + 30 + 15 = 105s, which this limit has to exceed: under it,
    // a real failure reports "timed out" instead of naming the step that never happened.
  }, 150_000)
})
