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
 * Its own file because the fact under test happens exactly once, while the
 * module is being built: a second test in a file that has already built it
 * would be asserting against a service that was constructed long before the
 * stale directory existed. */

/**
 * What the last run left behind, planted before anything is constructed.
 *
 * Module scope, not inside the test, for the same reason: by the time a test
 * body runs the service may already exist, and then there would be nothing for
 * the wipe to have removed.
 */
const stale = GdalCache.directory("raster", "from-a-previous-run")
fs.mkdirSync(stale, { recursive: true })
fs.writeFileSync(path.join(stale, "preview.webp"), "old bytes")

afterAll(() => fs.rmSync(GdalCache.ROOT, { recursive: true, force: true }))

const it = testEffect(LayerNode.compile(LayerNode.group([GdalService.node])))

describe("gdal artifact lifetime", () => {
  it.live("building the module clears what the last run left behind", () =>
    Effect.gen(function* () {
      // Every startup begins cold. That keeps the cache from growing without
      // bound — no size budget, no eviction policy, no accumulated keys — and
      // it keeps "what does a first view actually cost" an answerable question
      // after the first run, which a warm cache makes unaskable (§7.6).
      yield* GdalService.Service
      expect(fs.existsSync(stale)).toBe(false)
    }),
  )
})
