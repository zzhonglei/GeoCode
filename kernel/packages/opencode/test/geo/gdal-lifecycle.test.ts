import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { MachineConfig } from "@/geo/config"
import { GdalService } from "@/geo/gdal"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* The GDAL lifecycle (docs/GEOKERNEL.md §7.3). */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const writeBroken = () => Effect.promise(() => fs.promises.writeFile(FILE, '{ "gdal": "/opt", }}', "utf-8"))

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gdal-lc-"))
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(FILE, { force: true })
})

function toolDir(name: string, tools: readonly string[]): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const suffix = process.platform === "win32" ? ".exe" : ""
  for (const tool of tools) fs.writeFileSync(path.join(dir, `${tool}${suffix}`), "")
  return dir
}

const RASTER = ["gdalinfo", "gdalwarp", "gdal_translate", "gdaldem"]
const VECTOR = ["ogrinfo", "ogr2ogr"]

const waitForStatus = (predicate: (status: GeoEvent.GdalStatus) => boolean, message: string) =>
  Effect.gen(function* () {
    const status = yield* GeoStatus.Service
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* status.current("gdal")
        return current && predicate(current) ? current : undefined
      }),
      message,
      "15 seconds",
    )
  })

const it = testEffect(
  LayerNode.compile(LayerNode.group([GdalService.node, EventV2.node, MachineConfig.node, GeoStatus.node])),
)

describe("gdal lifecycle", () => {
  it.live(
    "a config edit lands on the status slot without anything in between",
    () =>
      Effect.gen(function* () {
        const full = toolDir("full", [...RASTER, ...VECTOR])
        yield* write({ gdal: full })
        yield* waitForStatus((s) => s.status === "ready", "never reached ready")

        yield* write({ gdal: path.join(root, "nowhere") })
        const missing = yield* waitForStatus((s) => s.status === "dir-missing", "never reported the missing directory")
        expect(missing).toEqual({ status: "dir-missing", directory: path.join(root, "nowhere") })
      }),
    { timeout: 30000 },
  )

  it.live(
    "half an install opens half the data plane",
    () =>
      Effect.gen(function* () {
        const gdal = yield* GdalService.Service
        yield* write({ gdal: toolDir("rasteronly", RASTER) })
        yield* waitForStatus((s) => s.status === "raster-only", "never reported raster-only")

        const raster = yield* gdal.gate("raster")
        expect(raster.ok).toBe(true)
        if (raster.ok) expect(raster.environment.tools.gdalinfo).toContain("gdalinfo")

        const vector = yield* gdal.gate("vector")
        expect(vector.ok).toBe(false)
        if (!vector.ok) expect(vector.status).toEqual({ status: "raster-only", missing: VECTOR })
      }),
    { timeout: 30000 },
  )

  it.live(
    "an unconfigured machine refuses both tracks and offers no environment",
    () =>
      Effect.gen(function* () {
        const gdal = yield* GdalService.Service
        yield* write({})
        yield* waitForStatus((s) => s.status === "unconfigured", "never returned to unconfigured")

        for (const track of ["raster", "vector"] as const) {
          const gate = yield* gdal.gate(track)
          expect(gate.ok).toBe(false)
          if (!gate.ok) expect(gate.status).toEqual({ status: "unconfigured" })
        }
      }),
    { timeout: 30000 },
  )

  it.live(
    "a config file that will not parse says so, and does not claim to be unconfigured",
    () =>
      Effect.gen(function* () {
        const gdal = yield* GdalService.Service
        yield* writeBroken()
        const status = yield* waitForStatus((s) => s.status === "config-error", "never reported the parse failure")

        expect(status).toMatchObject({ status: "config-error", file: FILE })
        // Guards against the loader's fallback message, a bare class name with no position (geo/config/loader.ts).
        if (status.status === "config-error") expect(status.message).toMatch(/line \d+, column \d+/)

        for (const track of ["raster", "vector"] as const) {
          expect((yield* gdal.gate(track)).ok).toBe(false)
        }
      }),
    { timeout: 30000 },
  )
})
