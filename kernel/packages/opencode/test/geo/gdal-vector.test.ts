import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GdalCache } from "@/geo/gdal/cache"
import { GdalVector } from "@/geo/gdal/vector"
import { GeoRuntime } from "@/geo/runtime"
import type { GdalTypes } from "@/geo/gdal/types"
import { testEffect } from "../lib/effect"

/* The vector pipeline (docs/GEOKERNEL.md §7.4).
 *
 * The subprocesses are scripted so the pipeline's own decisions are what gets
 * tested: which of the three page levels answered, whether the guard spent a
 * conversion before refusing, and what the caller is told. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gdal-vec-"))
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(GdalCache.ROOT, { recursive: true, force: true })
})

/**
 * A distinct source per scenario.
 *
 * Same file plus same toolchain is the same cache key — by design — so sharing
 * one path across blocks would let one scenario read the artifact another one
 * produced. That is the cache behaving correctly and the fixture being wrong.
 */
const sourceFor = (name: string) => {
  const target = path.join(root, name + ".geojson")
  fs.writeFileSync(target, "{}")
  return target
}

const environment: GdalTypes.Environment = {
  directory: "/tools",
  fingerprint: "fp-test",
  tools: {
    gdalinfo: "/tools/gdalinfo",
    gdalwarp: "/tools/gdalwarp",
    gdal_translate: "/tools/gdal_translate",
    gdaldem: "/tools/gdaldem",
    ogrinfo: "/tools/ogrinfo",
    ogr2ogr: "/tools/ogr2ogr",
  },
  env: {},
}

const collection = (count: number, type = "Point") =>
  JSON.stringify({
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, i) => ({
      type: "Feature",
      geometry: { type, coordinates: [i, i] },
      properties: { id: i },
    })),
  })

const summary = (featureCount: number, name = "layer") =>
  JSON.stringify({
    layers: [
      {
        name,
        featureCount,
        geometryFields: [{ type: "Point", coordinateSystem: { projjson: { id: { authority: "EPSG", code: 4326 } } } }],
        fields: [{ name: "id" }],
      },
    ],
  })

/** A runtime answering per tool, recording every command it was given. */
function scripted(answer: (command: string, args: readonly string[]) => string | { fail: true }) {
  const calls = Ref.makeUnsafe<{ command: string; args: readonly string[] }[]>([])
  const layer = Layer.succeed(
    GeoRuntime.Service,
    GeoRuntime.Service.of({
      run: (options) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (all) => [...all, { command: options.command, args: options.args }])
          const scriptedAnswer = answer(options.command, options.args)
          if (typeof scriptedAnswer !== "string") {
            return { code: 1, reason: "exit", stdout: "", stderr: "scripted failure", durationMs: 1 } as never
          }
          return {
            code: 0,
            reason: "exit",
            stdout: scriptedAnswer,
            stderr: "",
            durationMs: 1,
            truncated: false,
            drainIncomplete: false,
          } as never
        }),
      start: () => Effect.die("not used"),
      list: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
      killAllSync: () => {},
    }),
  )
  return { layer, calls }
}

const tools = (calls: { command: string }[]) => calls.map((c) => path.basename(c.command))

describe("gdal vector delivery", () => {
  {
    const http = scripted((command) => (command.endsWith("ogrinfo") ? summary(9_000) : collection(9_000)))
    const source = sourceFor("refused")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, http.layer]]))

    it.live("a layer the interface will not draw is refused before anything is converted", () =>
      Effect.gen(function* () {
        const vector = yield* GdalVector.make()
        const outcome = yield* Effect.result(vector.content(environment, source))
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure") {
          expect((outcome.failure as GdalVector.GdalVectorError).kind).toBe("too-many-features")
          // Structured, so the interface can say how far over it is rather than
          // showing a sentence it cannot reason about (§7.7).
          expect((outcome.failure as GdalVector.GdalVectorError).featureCount).toBe(9_000)
        }
        // The count came from the header, so the refusal cost one summary call
        // and no conversion at all.
        expect(tools(yield* Ref.get(http.calls))).toEqual(["ogrinfo"])
      }),
    )
  }

  {
    const http = scripted((command) => (command.endsWith("ogrinfo") ? summary(2) : collection(2)))
    const source = sourceFor("delivered")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, http.layer]]))

    it.live("a layer within the limit is converted to web mercator and kept", () =>
      Effect.gen(function* () {
        const vector = yield* GdalVector.make()
        const first = yield* vector.content(environment, source)
        expect(JSON.parse(first).features).toHaveLength(2)

        const converted = (yield* Ref.get(http.calls)).find((c) => c.command.endsWith("ogr2ogr"))
        // The front end performs no projection arithmetic — that promise is
        // kept here or nowhere (§7.4).
        expect(converted?.args).toContain("EPSG:3857")

        // Asked again, the conversion is not repeated.
        yield* vector.content(environment, source)
        expect((yield* Ref.get(http.calls)).filter((c) => c.command.endsWith("ogr2ogr"))).toHaveLength(1)
      }),
    )
  }
})

describe("gdal vector paging", () => {
  {
    const http = scripted((command, args) => {
      if (command.endsWith("ogrinfo")) return summary(50_000)
      // The engine honours the window it was asked for.
      const sql = args[args.indexOf("-sql") + 1] ?? ""
      return /LIMIT 2/.test(sql) ? collection(2) : collection(50_000)
    })
    const source = sourceFor("paged")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, http.layer]]))

    it.live("a layer too large to deliver whole can still be paged through", () =>
      Effect.gen(function* () {
        const vector = yield* GdalVector.make()
        const page = yield* vector.page(environment, source, 10, 2)
        expect(page.features).toHaveLength(2)
        // The total comes from the header, not from counting what was returned.
        expect(page.total).toBe(50_000)

        const query = (yield* Ref.get(http.calls)).find((c) => c.args.includes("-sql"))
        expect(query?.args.join(" ")).toContain("LIMIT 2 OFFSET 10")
      }),
    )
  }

  {
    const http = scripted((command) => (command.endsWith("ogrinfo") ? summary(3) : collection(3)))
    const source = sourceFor("turns")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, http.layer]]))

    it.live("page turns on an open layer stop spawning anything at all", () =>
      Effect.gen(function* () {
        const vector = yield* GdalVector.make()
        yield* vector.content(environment, source)
        const before = (yield* Ref.get(http.calls)).length

        const first = yield* vector.page(environment, source, 0, 2)
        const second = yield* vector.page(environment, source, 2, 2)
        expect(first.features).toHaveLength(2)
        expect(second.features).toHaveLength(1)
        expect(first.total).toBe(3)

        // Parsing megabytes of JSON is worth doing once; turning a page is not
        // a reason to do it again, let alone to spawn a process.
        expect((yield* Ref.get(http.calls)).length).toBe(before)
      }),
    )
  }
})

describe("gdal vector metadata", () => {
  {
    const http = scripted((command) => (command.endsWith("ogrinfo") ? { fail: true } : collection(4, "LineString")))
    const source = sourceFor("fallback")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, http.layer]]))

    it.live("a header that cannot be summarized falls back, and the fallback is not paid for twice", () =>
      Effect.gen(function* () {
        const vector = yield* GdalVector.make()
        const meta = yield* vector.meta(environment, source)
        expect(meta.featureCount).toBe(4)
        // Read off the features themselves, since there was no declaration.
        expect(meta.geometryTypes).toEqual(["LineString"])
        expect(meta.properties).toEqual(["id"])

        // The fallback converted, and kept what it produced — so the content
        // phase behind it finds the work already done (§7.4).
        const conversions = (yield* Ref.get(http.calls)).filter((c) => c.command.endsWith("ogr2ogr")).length
        yield* vector.page(environment, source, 0, 2)
        expect((yield* Ref.get(http.calls)).filter((c) => c.command.endsWith("ogr2ogr"))).toHaveLength(conversions)
      }),
    )
  }
})

describe("gdal vector queries", () => {
  const it = testEffect(Layer.empty)

  it.effect("a layer name with a quote in it cannot break the query", () =>
    Effect.sync(() => {
      // The name comes from the engine, not from us, and a file may legally be
      // called anything at all.
      expect(GdalVector.pageQuery('odd"name', 0, 10)).toBe('SELECT * FROM "odd""name" LIMIT 10 OFFSET 0')
    }),
  )

  it.effect("the window is always whole and never negative", () =>
    Effect.sync(() => {
      expect(GdalVector.pageQuery("layer", -5, 10.7)).toBe('SELECT * FROM "layer" LIMIT 10 OFFSET 0')
    }),
  )
})
