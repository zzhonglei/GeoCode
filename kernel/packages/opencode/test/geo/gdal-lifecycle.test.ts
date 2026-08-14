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

/* The GDAL lifecycle (docs/GEOKERNEL.md §7.3).
 *
 * The thinnest lifecycle in the kernel: one transition, no intermediate state,
 * no polling. What is worth pinning is therefore not the machinery but the
 * shape of the answer — that the gate is per TRACK, and that an install with
 * half the binaries is told which half it has. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
/** Deliberately unparsable, the way a hand-edited file goes wrong. */
const writeBroken = () => Effect.promise(() => fs.promises.writeFile(FILE, '{ "gdal": "/opt", }}', "utf-8"))

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gdal-lc-"))
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(FILE, { force: true })
})

/** A tool directory holding exactly the named binaries. */
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

        // No intermediate state on the way: the probe is file existence, so
        // there is nothing to wait for and nothing to show a user (§7.3).
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

        // The two tracks depend on disjoint tools, so the gate is per track —
        // the opposite of QGIS, where one environment serves everything (§7.3).
        const raster = yield* gdal.gate("raster")
        expect(raster.ok).toBe(true)
        if (raster.ok) expect(raster.environment.tools.gdalinfo).toContain("gdalinfo")

        const vector = yield* gdal.gate("vector")
        expect(vector.ok).toBe(false)
        // The refusal carries the status, not a sentence: the interface reacts
        // differently to "missing binaries" than to "not configured" (§7.7).
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
          // Nothing to hand over, and no directory to have taken a snapshot of.
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

        // Two different facts needing two different actions from the user: one
        // has a file to fix, the other has a field to fill. Reporting the first
        // as "unconfigured" sends them to redo work they already did (§8.1).
        expect(status).toMatchObject({ status: "config-error", file: FILE })
        // Not `length > 0`, which is what this asserted while the message was
        // the literal class name "ConfigJsonError" — fifteen characters that
        // pass that check and say nothing, at the moment §3.1 has switched every
        // geographic capability off. A position is the least that is actionable.
        if (status.status === "config-error") expect(status.message).toMatch(/line \d+, column \d+/)

        // And no track runs on a configuration nobody could read.
        for (const track of ["raster", "vector"] as const) {
          expect((yield* gdal.gate(track)).ok).toBe(false)
        }
      }),
    { timeout: 30000 },
  )
})
