import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GdalService } from "@/geo/gdal"
import { GdalCache } from "@/geo/gdal/cache"
import { testEffect } from "../lib/effect"

/* Artifact lifetime at startup (docs/GEOKERNEL.md §7.6).
 *
 * Its own file because the wipe happens once, while the module is built: a test in a file that has already built the
 * service would be asserting against something constructed before the stale directory existed. */

/** What the last run left behind, planted at module scope so it is there before anything constructs the service. */
const stale = GdalCache.directory("raster", "from-a-previous-run")
fs.mkdirSync(stale, { recursive: true })
fs.writeFileSync(path.join(stale, "preview.webp"), "old bytes")

afterAll(() => fs.rmSync(GdalCache.ROOT, { recursive: true, force: true }))

const it = testEffect(LayerNode.compile(LayerNode.group([GdalService.node])))

describe("gdal artifact lifetime", () => {
  it.live("building the module clears what the last run left behind", () =>
    Effect.gen(function* () {
      yield* GdalService.Service
      expect(fs.existsSync(stale)).toBe(false)
    }),
  )
})
