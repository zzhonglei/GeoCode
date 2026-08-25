import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { GdalCache } from "@/geo/gdal/cache"
import { testEffect } from "../lib/effect"

/* Artifact identity and in-flight merging (docs/GEOKERNEL.md §7.6). */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gdal-cache-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const file = (name: string, content: string) => {
  const target = path.join(root, name)
  fs.writeFileSync(target, content)
  return target
}

const it = testEffect(Layer.empty)

describe("gdal cache keys", () => {
  it.effect("the same file under the same toolchain keys the same", () =>
    Effect.sync(() => {
      const tif = file("stable.tif", "pixels")
      const first = GdalCache.key(GdalCache.describe(tif), "fp-1")
      const second = GdalCache.key(GdalCache.describe(tif), "fp-1")
      expect(first).toBe(second)
    }),
  )

  it.effect("a rewrite of the same length still changes the key", () =>
    Effect.sync(() => {
      const tif = file("samelength.tif", "aaaa")
      const before = GdalCache.key(GdalCache.describe(tif), "fp")
      const later = new Date(Date.now() + 5000)
      fs.writeFileSync(tif, "bbbb")
      fs.utimesSync(tif, later, later)
      expect(GdalCache.key(GdalCache.describe(tif), "fp")).not.toBe(before)
    }),
  )

  it.effect("changing which toolchain is configured retires the old artifacts", () =>
    Effect.sync(() => {
      const tif = file("toolchain.tif", "pixels")
      const source = GdalCache.describe(tif)
      expect(GdalCache.key(source, "gdal-3.9")).not.toBe(GdalCache.key(source, "gdal-3.13"))
    }),
  )

  it.effect("a shapefile's companions are part of its identity", () =>
    Effect.sync(() => {
      const shp = file("layer.shp", "geometry")
      file("layer.dbf", "attributes")
      file("layer.prj", "crs")
      const before = GdalCache.key(GdalCache.describe(shp), "fp")

      const later = new Date(Date.now() + 5000)
      fs.writeFileSync(path.join(root, "layer.dbf"), "different attributes")
      fs.utimesSync(path.join(root, "layer.dbf"), later, later)
      expect(GdalCache.key(GdalCache.describe(shp), "fp")).not.toBe(before)
    }),
  )

  it.effect("a companion appearing later changes the key too", () =>
    Effect.sync(() => {
      const shp = file("late.shp", "geometry")
      const before = GdalCache.key(GdalCache.describe(shp), "fp")
      file("late.prj", "crs")
      expect(GdalCache.key(GdalCache.describe(shp), "fp")).not.toBe(before)
    }),
  )

  it.effect("a raster is not made to pay for companions it cannot have", () =>
    Effect.sync(() => {
      expect(GdalCache.describe(file("plain.tif", "pixels")).sidecars).toEqual([])
    }),
  )

  it.effect("the two tracks do not share a directory", () =>
    Effect.sync(() => {
      expect(GdalCache.directory("raster", "abc")).not.toBe(GdalCache.directory("vector", "abc"))
      expect(GdalCache.directory("raster", "abc").startsWith(GdalCache.ROOT)).toBe(true)
    }),
  )
})

describe("gdal concurrent production", () => {
  // Real clock: under the test clock nothing advances the sleep that lets the second fiber arrive.
  it.live("callers arriving together produce once and all get the answer", () =>
    Effect.gen(function* () {
      const merge = yield* GdalCache.merger<string, never>()
      const runs = yield* Ref.make(0)
      const gate = Deferred.makeUnsafe<void>()
      const produce = Effect.gen(function* () {
        yield* Ref.update(runs, (n) => n + 1)
        yield* Deferred.await(gate)
        return "artifact"
      })

      const a = yield* Effect.forkScoped(merge("key", produce))
      const b = yield* Effect.forkScoped(merge("key", produce))
      yield* Effect.sleep("20 millis")
      Deferred.doneUnsafe(gate, Effect.void)

      expect(yield* Fiber.join(a)).toBe("artifact")
      expect(yield* Fiber.join(b)).toBe("artifact")
      expect(yield* Ref.get(runs)).toBe(1)
    }),
  )

  it.live("one caller giving up does not take the others down with it", () =>
    Effect.gen(function* () {
      const merge = yield* GdalCache.merger<string, never>()
      const gate = Deferred.makeUnsafe<void>()
      const produce = Deferred.await(gate).pipe(Effect.as("artifact"))

      const first = yield* Effect.forkScoped(merge("shared", produce))
      const second = yield* Effect.forkScoped(merge("shared", produce))
      yield* Effect.sleep("20 millis")

      yield* Fiber.interrupt(first)
      Deferred.doneUnsafe(gate, Effect.void)
      expect(yield* Fiber.join(second)).toBe("artifact")
    }),
  )

  it.effect("a settled key is produced again next time, not remembered", () =>
    Effect.gen(function* () {
      const merge = yield* GdalCache.merger<number, never>()
      const runs = yield* Ref.make(0)
      const produce = Ref.updateAndGet(runs, (n) => n + 1)

      expect(yield* merge("key", produce)).toBe(1)
      expect(yield* merge("key", produce)).toBe(2)
    }),
  )
})
