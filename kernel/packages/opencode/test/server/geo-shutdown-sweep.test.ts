import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/* Geographic processes go down with the server (docs/GEOKERNEL.md §10.1 #8b).
 *
 * A real server, a real signal, a real child. Nothing smaller would do: the
 * fact under test is that Node's DEFAULT handling of SIGTERM terminates without
 * running any `exit` listener, so the Runtime module's own last line of defence
 * never fires. That is invisible to a typecheck and to every in-process test —
 * it only shows up as a QGIS algorithm still burning a core after the user has
 * quit, with no window left to stop it from (§3.2, process drift).
 *
 * Confirmed to discriminate: with the handler removed, the child below survives
 * its parent. */

const TOOLS = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem", "ogrinfo", "ogr2ogr"]
const ROOT = path.join(import.meta.dir, "..", "..")

const it = process.platform === "win32" ? test.skip : test

/** Derived from this process, so a parallel suite cannot collide on it. */
const PORT = 20000 + (process.pid % 10000)

/** A toolchain of scripts that record their pid and then never finish. */
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
      // Not piped: nothing here reads them, and a full pipe buffer would block
      // the server mid-boot.
      stdout: "ignore",
      stderr: "ignore",
    })

    const reachable = async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}/geo/status`)
        return true
      } catch {
        return false
      }
    }

    try {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !(await reachable())) await Bun.sleep(250)
      expect(await reachable()).toBe(true)

      // Ask for a preview; the fake toolchain hangs, so the child stays up
      // while we signal its parent.
      const ask = fetch(`http://127.0.0.1:${PORT}/geo/raster/meta?path=scene.tif&directory=${project}`).catch(
        () => undefined,
      )
      await waitFor(() => fs.existsSync(pidFile), 30_000)
      expect(fs.existsSync(pidFile)).toBe(true)

      const child = Number(fs.readFileSync(pidFile, "utf8").trim())
      expect(alive(child)).toBe(true)

      server.kill("SIGTERM")
      await waitFor(() => !alive(child), 15_000)
      // Without the handler this is still running, with nothing left to stop
      // it — the user quit and the CPU is still busy.
      expect(alive(child)).toBe(false)
      await ask
    } finally {
      server.kill("SIGKILL")
      const recorded = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : 0
      if (recorded && alive(recorded)) process.kill(recorded, "SIGKILL")
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 90_000)
})
