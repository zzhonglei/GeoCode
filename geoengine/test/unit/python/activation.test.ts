import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Environment } from "../../../src/python/index.ts"
import { python3 } from "../../support/common.ts"
import { start } from "../../support/engine.ts"
import { bundle, settle, sitePackages, temporary } from "../../support/python.ts"

test(
  "the working environment's pip takes every package the base has at every start as a constraint",
  { skip: !python3 },
  async () => {
    // In a home with a space and a Chinese character, as many users' are.
    const directory = path.join(await temporary(), "Lei Zhong 张三")
    try {
      await fs.mkdir(directory)
      const where = Environment.layout(path.join(directory, "data"))
      const bundled = await bundle(directory, "one")
      await settle(directory, bundled)
      // Guards against a constraint list kept anywhere but in what the base has installed at this start.
      const info = path.join(sitePackages(where), "Fakegeo-1.2.3.dist-info")
      await fs.mkdir(info)
      await fs.writeFile(path.join(info, "METADATA"), "Metadata-Version: 2.1\nName: Fakegeo\nVersion: 1.2.3\n")
      await settle(directory, bundled)

      const pinned = (await fs.readFile(where.constraints, "utf-8")).split("\n")
      assert.ok(pinned.includes("Fakegeo==1.2.3"), pinned.join("\n"))
      assert.ok(
        pinned.some((line) => line.startsWith("geocodekit==")),
        pinned.join("\n"),
      )
      // Guards against a configuration pip does not read, by its name or its place, which would let an install replace
      // the base's GDAL with PyPI's without a word, and one it cannot follow to the file, which stops every install.
      const refused = spawnSync(where.envPip, ["install", "--no-index", "Fakegeo==9"], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH, HOME: directory },
      })
      const output = refused.stdout + refused.stderr
      assert.notEqual(refused.status, 0)
      assert.match(output, /ResolutionImpossible/)
      assert.match(output, /\(constraint\) fakegeo==1\.2\.3/i)
    } finally {
      await fs.rm(path.dirname(directory), { recursive: true, force: true })
    }
  },
)

test(
  "once the environment is ready, python.activation gives what GeoAgent's shell needs to run it",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    const where = Environment.layout(path.join(directory, "data"))
    const capability = Environment.capability({
      bundle: await bundle(directory, "one"),
      data: path.join(directory, "data"),
    })
    const engine = await start("python", () => [capability])
    try {
      await engine.settled<Environment.State>("python", 30000, ["checking", "preparing"])
      const response = await engine.response(engine.send("python.activation", {}))
      assert.ok(response.ok)
      const activation = response.result as Environment.Activation
      // Guards against the shell finding the user's python, pip and GDAL commands before the environment's.
      assert.equal(activation.path[0], path.join(where.env, "bin"))
      const base = path.dirname(activation.path[1]!)
      // Guards against the shell's GDAL commands finding the user's data and plugins, or none, and its Python the
      // user's own packages, which the variables of an isolated run keep out.
      assert.deepEqual(activation.set, {
        GDAL_DATA: path.join(base, "share", "gdal"),
        GDAL_DRIVER_PATH: path.join(base, "lib", "gdalplugins"),
        PROJ_DATA: path.join(base, "share", "proj"),
        PROJ_NETWORK: "ON",
        PROJ_USER_WRITABLE_DIRECTORY: path.join(path.dirname(base), "proj"),
        GDAL_CONFIG_FILE: path.join(base, "gdalrc"),
        PYTHONNOUSERSITE: "1",
      })
      assert.deepEqual(activation.remove, ["PYTHONPATH", "PYTHONHOME"])
    } finally {
      await engine.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)
