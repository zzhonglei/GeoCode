import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { GeoRuntime } from "@/geo/runtime"
import { GeoRuntime as GeoRuntimeModule } from "@/geo/runtime"
import { Georeference } from "@/geo/georeference"
import { QgisReader } from "@/geo/qgis/reader"
import { RASTER_PREVIEW_PY, RASTER_READ_PY, VECTOR_READ_PY } from "@/geo/qgis/scripts.generated"
import type { Environment } from "@/geo/qgis/types"
import { testEffect } from "../lib/effect"

/* The data-reading pipeline (docs/GEOKERNEL.md §4.13).
 *
 * The scripts themselves ran against real QGIS 3.44.9 (vector with Chinese
 * attribute values, raster, preview). These tests freeze the protocol: the
 * generated constants stay in sync with the .py sources, every script keeps
 * the four §4.13 constraints, and the reader's parsing survives the noise and
 * BOM interleaving the protocol exists for. */

const SCRIPTS = [
  { file: "vector_read.py", constant: VECTOR_READ_PY },
  { file: "raster_read.py", constant: RASTER_READ_PY },
  { file: "raster_preview.py", constant: RASTER_PREVIEW_PY },
] as const

describe("qgis reader script assets", () => {
  test("the generated constants match the .py sources", () => {
    // The build chain regenerates before every build, but a checkout edited
    // without rebuilding would ship stale scripts silently — this makes it
    // loud at test time instead (§4.13 构建链).
    for (const script of SCRIPTS) {
      const source = fs.readFileSync(
        path.join(import.meta.dir, "..", "..", "src", "geo", "qgis", "scripts", script.file),
        "utf8",
      )
      if (source !== script.constant) {
        throw new Error(
          `${script.file} is out of sync with scripts.generated.ts — run: bun run script/gen-geo-scripts.ts`,
        )
      }
    }
  })

  test("every script keeps the §4.13 protocol constraints", () => {
    for (const script of SCRIPTS) {
      // 1. Marker output protocol — one shared marker for the family.
      expect(script.constant).toContain(QgisReader.MARKER)
      // 3. Immediate exit after output, skipping interpreter teardown.
      expect(script.constant).toContain("os._exit(")
      // 4. Fault handler enabled BEFORE any osgeo import: order in the file
      // is order of execution.
      const handler = script.constant.indexOf("faulthandler.enable")
      const osgeo = script.constant.indexOf("from osgeo")
      expect(handler).toBeGreaterThan(-1)
      expect(osgeo).toBeGreaterThan(handler)
      // 2. UTF-8 comes from the subprocess environment; the script keeps
      // non-ASCII values raw rather than escaping them away.
      expect(script.constant).toContain("ensure_ascii=False")
    }
  })

  test("both raster scripts gather the five facts with the very same function", () => {
    // Neither script judges: the rule is one function in TypeScript
    // (geo/georeference.ts, §7.9). What they owe is the EVIDENCE, and they must
    // owe the same of it — omit a place in one and metadata mode opens a scene
    // that preview mode refuses.
    //
    // Compared rather than described. Python cannot share a function across two
    // materialized scripts without a module to import, and that module cost
    // more than it bought; what it can do is carry the same one twice and have
    // this notice the day they stop being the same.
    const gathering = (script: string) => /^def georeferencing_facts[\s\S]*?\n    \}$/m.exec(script)?.[0]
    const fromRead = gathering(RASTER_READ_PY)
    expect(fromRead).toBeDefined()
    expect(gathering(RASTER_PREVIEW_PY)).toBe(fromRead!)

    for (const call of [
      "GetGeoTransform()",
      "GetProjection()",
      "GetGCPCount()",
      'GetMetadata("RPC")',
      'GetMetadata("GEOLOCATION")',
    ]) {
      expect(fromRead).toContain(call)
    }
    for (const script of [RASTER_READ_PY, RASTER_PREVIEW_PY]) expect(script).toContain('"georeferencing"')

    // The other half of the seam: the key names, read by the side that judges.
    const facts = { transform: [0, 1, 0, 0, 0, 1], projection: false, gcp_count: 3, rpc: false, geolocation: false }
    expect(Georeference.of(Georeference.reported(facts))).toBe("gcp")
  })

  test("the raster extent comes back the way its field names promise", () => {
    // A transform may step negatively in x, and the identity GDAL hands back
    // for "no transform" steps POSITIVELY in y — either way the corner
    // computed as the minimum can land above the one computed as the maximum.
    // The GDAL face normalizes (its own test, gdal-inspector.test.ts); this
    // one has to as well, or one file has its extent one way round for the
    // Agent and the other for the map.
    //
    // Textual, like the §4.13 constraints above, and for the same reason: the
    // script needs a GDAL to run. This is the line that would go quiet if
    // someone tidied it back into two subtractions.
    expect(RASTER_READ_PY).toContain("xmin, xmax = min(x0, x1), max(x0, x1)")
    expect(RASTER_READ_PY).toContain("ymin, ymax = min(y0, y1), max(y0, y1)")
  })
})

describe("qgis reader materialization", () => {
  test("content-hash naming refreshes on change and reuses on repeat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-reader-"))
    try {
      const first = QgisReader.materialize("probe", "print(1)\n", dir)
      expect(fs.existsSync(first)).toBe(true)
      expect(path.basename(first)).toMatch(/^probe-[0-9a-f]{8}\.py$/)

      // Same content → same path, no rewrite needed.
      expect(QgisReader.materialize("probe", "print(1)\n", dir)).toBe(first)

      // Changed content → a NEW name; the old file cannot be mistaken for it.
      const second = QgisReader.materialize("probe", "print(2)\n", dir)
      expect(second).not.toBe(first)
      expect(fs.readFileSync(second, "utf8")).toBe("print(2)\n")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

interface StubCall {
  readonly options: GeoRuntime.Options
}

function stubRuntime(results: Partial<GeoRuntime.Result>[], calls: StubCall[] = []) {
  let index = 0
  const layer = Layer.mock(GeoRuntimeModule.Service)({
    run: (options: GeoRuntime.Options) => {
      calls.push({ options })
      const result = results[Math.min(index++, results.length - 1)] ?? {}
      return Effect.succeed({
        reason: "exit",
        code: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
        truncated: false,
        drainIncomplete: false,
        ...result,
      } satisfies GeoRuntime.Result)
    },
    killAllSync: () => {},
  })
  return { layer, calls }
}

const environment: Environment = {
  python: "/fake/python3.12",
  prefix: "/fake",
  env: { QGIS_PREFIX_PATH: "/fake" },
  dllDirectories: [],
  versions: { python: "3", gdal: "3", qgis: "3" },
  processing: true,
}

const run = <A>(
  results: Partial<GeoRuntime.Result>[],
  body: (runtime: GeoRuntime.Interface, calls: StubCall[]) => Effect.Effect<A, Error>,
) => {
  const { layer, calls } = stubRuntime(results)
  const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntimeModule.node]), [[GeoRuntimeModule.node, layer]]))
  return {
    it,
    body: () =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntimeModule.Service
        return yield* body(runtime, calls)
      }),
  }
}

describe("qgis reader pipeline", () => {
  {
    const marked = `${QgisReader.MARKER}{"driver":"GeoJSON","layer_index":0,"layer":{"name":"街道","feature_count":7}}`
    const { it, body } = run([{ stdout: `import noise\n${marked}\n` }], (runtime, calls) =>
      Effect.gen(function* () {
        const outcome = yield* QgisReader.readVector(runtime, environment, { file: "/data/街道.geojson" })
        expect(outcome.ok).toBe(true)
        if (outcome.ok) {
          // Chinese attribute values survive the wire raw — that is what
          // ensure_ascii=False plus forced-UTF-8 streams exist for.
          expect((outcome.payload.layer as Record<string, unknown>).name).toBe("街道")
        }

        // The spawn carries the verified environment whole, the script runs
        // MATERIALIZED (a .py path, not -c), and defaults fill the argv.
        const options = calls[0]!.options
        expect(options.command).toBe(environment.python)
        expect(options.env).toMatchObject(environment.env)
        // And one thing the verified environment does not carry: reading a
        // raster computes statistics, and GDAL saves what it computed as a
        // `.aux.xml` beside the user's data unless told not to (§7.6). The
        // GDAL face has guarded this from the start; this one did not.
        expect(options.env!.GDAL_PAM_ENABLED).toBe("NO")
        expect(options.args[0]!.endsWith(".py")).toBe(true)
        expect(options.args.slice(1)).toEqual(["/data/街道.geojson", "3", "1"])
        expect(options.delivery).toEqual({ mode: "collect", limit: 32 * 1024 * 1024 })
      }),
    )
    it.effect("a marked vector payload parses and the spawn shape is right", body)
  }

  {
    const { it, body } = run([{ stdout: "" }], (runtime, calls) =>
      Effect.gen(function* () {
        yield* QgisReader.readVector(runtime, environment, {
          file: "/d.gpkg",
          maxFeatures: 10,
          offset: 5,
          layerIndex: 2,
        })
        expect(calls[0]!.options.args.slice(1)).toEqual(["/d.gpkg", "10", "5", "2"])
      }),
    )
    it.effect("explicit options travel as argv, layer index only when given", body)
  }

  {
    const { it, body } = run([{ stdout: `x` }], (runtime, calls) =>
      Effect.gen(function* () {
        const dllEnvironment: Environment = { ...environment, dllDirectories: ["C:\\qgis\\bin"] }
        const outcome = yield* QgisReader.readRaster(runtime, dllEnvironment, { file: "C:\\data\\dem.tif" })
        expect(outcome.ok).toBe(false)

        // The manual Windows track rewrites the invocation: DLL registration
        // first, then the materialized script re-run with argv preserved
        // (§4.5) — the file argument must survive into the rewritten argv.
        const args = calls[0]!.options.args
        expect(args[0]).toBe("-c")
        expect(args[1]).toContain("add_dll_directory")
        expect(args[1]).toContain("runpy")
        expect(args[1]).toContain("C:\\\\data\\\\dem.tif")
      }),
    )
    it.effect("the manual-track DLL bootstrap rewrites the spawn, argv intact", body)
  }

  {
    const { it, body } = run(
      [
        {
          stdout: `noise\n${QgisReader.MARKER}{"error":"Cannot open vector file: /missing.shp"}\n`,
          reason: "exit",
          code: 1,
        },
      ],
      (runtime) =>
        Effect.gen(function* () {
          const outcome = yield* QgisReader.readVector(runtime, environment, { file: "/missing.shp" })
          expect(outcome.ok).toBe(false)
          if (!outcome.ok) {
            // The script's own sentence, clean — not buried in a raw tail.
            expect(outcome.detail).toBe("Cannot open vector file: /missing.shp")
          }
        }),
    )
    it.effect("a script-reported error surfaces as its own sentence", body)
  }

  {
    const { it, body } = run(
      [{ stdout: "Fatal Python error: Segmentation fault\n", stderr: "stack here", reason: "crash", code: null }],
      (runtime) =>
        Effect.gen(function* () {
          const outcome = yield* QgisReader.readRaster(runtime, environment, { file: "/dem.tif" })
          expect(outcome.ok).toBe(false)
          if (!outcome.ok) {
            // No marker: the raw output IS the diagnosis, led by the process
            // ending (§4.6 失败分级).
            expect(outcome.detail).toContain("never reached its output marker")
            expect(outcome.detail).toContain("[process crash]")
            expect(outcome.detail).toContain("Segmentation fault")
            expect(outcome.detail).toContain("stack here")
          }
        }),
    )
    it.effect("a crash without a marker keeps the raw output, ending first", body)
  }

  {
    // The Windows lesson, frozen: the console codepage flip interleaves
    // U+FEFF into stdout — including inside the marker line — and JSON.parse
    // rejects BOM as non-whitespace per RFC 8259.
    const bom = "\uFEFF"
    const { it, body } = run(
      [
        {
          stdout: `${bom}noise\n${QgisReader.MARKER.slice(0, 5)}${bom}${QgisReader.MARKER.slice(5)}{"driver":${bom}"ESRI Shapefile","layer":{}}\n`,
        },
      ],
      (runtime) =>
        Effect.gen(function* () {
          const outcome = yield* QgisReader.readVector(runtime, environment, { file: "/roads.shp" })
          expect(outcome.ok).toBe(true)
          if (outcome.ok) expect(outcome.payload.driver).toBe("ESRI Shapefile")
        }),
    )
    it.effect("interleaved BOM anywhere in the stream does not break parsing", body)
  }

  {
    // 9 bytes encode to exactly 12 base64 characters — the fixture has to be
    // self-consistent now that the payload is checked against the count.
    const meta = `${QgisReader.MARKER}{"width":64,"height":64,"original_width":128,"original_height":128,"bands":[1,2,3],"bytes":9}`
    const { it, body } = run([{ stdout: `gdal chatter\n${meta}\nMTIzNDU2Nzg5\n` }], (runtime, calls) =>
      Effect.gen(function* () {
        const outcome = yield* QgisReader.renderPreview(runtime, environment, { file: "/dem.tif" })
        expect(outcome.ok).toBe(true)
        if (outcome.ok) {
          expect(outcome.meta.width).toBe(64)
          expect(outcome.meta.bands).toEqual([1, 2, 3])
          expect(outcome.base64).toBe("MTIzNDU2Nzg5")
        }
        // The preview cap is the explicit upper-bound number, not a default.
        expect(calls[0]!.options.delivery).toEqual({ mode: "collect", limit: 128 * 1024 * 1024 })
      }),
    )
    it.effect("the preview's two-part output parses: marker meta, then image", body)
  }

  {
    const glued = `${QgisReader.MARKER}{"width":32,"height":32}`
    const { it: itGlued, body: bodyGlued } = run(
      // Unterminated C-level chatter glued to the front of the marker line —
      // the reason the scan is contains, not starts-with.
      [{ stdout: `Warning 1: no newline here${glued}\nQmFzZTY0\n` }],
      (runtime) =>
        Effect.gen(function* () {
          const outcome = yield* QgisReader.renderPreview(runtime, environment, { file: "/dem.tif" })
          expect(outcome.ok).toBe(true)
          if (outcome.ok) {
            expect(outcome.meta.width).toBe(32)
            expect(outcome.base64).toBe("QmFzZTY0")
          }
        }),
    )
    itGlued.effect("chatter glued to the marker line does not hide the preview", bodyGlued)
  }

  {
    const { it, body } = run([{ stdout: `${QgisReader.MARKER}{"width":64}\n\n` }], (runtime) =>
      Effect.gen(function* () {
        const outcome = yield* QgisReader.renderPreview(runtime, environment, { file: "/dem.tif" })
        expect(outcome.ok).toBe(false)
        // The undersized-cap signature gets its own message: metadata
        // arrived, the image did not (§4.13 校准量).
        if (!outcome.ok) expect(outcome.detail).toContain("no image payload")
      }),
    )
    it.effect("metadata without an image payload is called out by name", body)
  }

  {
    // The metadata line flushes ahead of the image, so a clock expiring
    // mid-transfer leaves a perfectly valid marker line above half a payload.
    // JSON.parse gives the metadata a completeness check for free; the image
    // needs this one, or a corrupt PNG ships as a success.
    const meta = `${QgisReader.MARKER}{"width":64,"height":64,"bytes":9}`
    const { it, body } = run([{ stdout: `${meta}\nMTIz`, reason: "timeout", code: null }], (runtime) =>
      Effect.gen(function* () {
        const outcome = yield* QgisReader.renderPreview(runtime, environment, { file: "/big.tif" })
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) {
          expect(outcome.detail).toContain("incomplete")
          expect(outcome.detail).toContain("4 of 12")
        }
      }),
    )
    it.effect("a truncated image is a failure, not a successful corrupt one", body)
  }

  {
    const { it, body } = run(
      [{ stdout: `${QgisReader.MARKER}{"error":"Cannot open raster file: /bad.tif"}\n` }],
      (runtime) =>
        Effect.gen(function* () {
          const outcome = yield* QgisReader.renderPreview(runtime, environment, { file: "/bad.tif" })
          expect(outcome.ok).toBe(false)
          if (!outcome.ok) expect(outcome.detail).toBe("Cannot open raster file: /bad.tif")
        }),
    )
    it.effect("a preview error payload surfaces as its own sentence", body)
  }
})
