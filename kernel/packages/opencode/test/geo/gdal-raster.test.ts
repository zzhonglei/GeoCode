import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Ref } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GdalCache } from "@/geo/gdal/cache"
import { GdalInspector } from "@/geo/gdal/inspector"
import { GdalRaster } from "@/geo/gdal/raster"
import { GeoRuntime } from "@/geo/runtime"
import type { GdalTypes } from "@/geo/gdal/types"
import { testEffect } from "../lib/effect"

/* The raster pipeline (docs/GEOKERNEL.md §7.5). The scripted half holds down which tools run and with what flags,
 * where the failures are the silent ones: a preview that writes beside the user's data, or that colours the empty
 * half of a scene. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gdal-raster-"))
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(GdalCache.ROOT, { recursive: true, force: true })
})

/** A distinct source per scenario: same file plus same toolchain is one key. */
const sourceFor = (name: string) => {
  const target = path.join(root, `${name}.tif`)
  fs.writeFileSync(target, "pixels")
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

const georeferenced = {
  size: [7531, 7691],
  geoTransform: [300000, 30, 0, 3530730, 0, -30],
  cornerCoordinates: { lowerLeft: [300000, 3300000], upperRight: [525930, 3530730] },
  coordinateSystem: { projjson: { id: { authority: "EPSG", code: 32649 } } },
}

const LANDSAT = JSON.stringify({
  ...georeferenced,
  bands: Array.from({ length: 12 }, (_, index) => ({
    colorInterpretation: index === 0 ? "Gray" : "Undefined",
    description: `B${index + 1}`,
    minimum: 0,
    maximum: 30000,
    mean: 9000,
    stdDev: 2000,
  })),
})

const DEM = JSON.stringify({
  ...georeferenced,
  bands: [
    { colorInterpretation: "Gray", description: "elevation", minimum: -138, maximum: 7467, mean: 1762, stdDev: 1712 },
  ],
})

const PLAIN = JSON.stringify({
  size: [800, 600],
  cornerCoordinates: { lowerLeft: [0, 0], upperRight: [800, 600] },
  bands: [{ colorInterpretation: "Red" }, { colorInterpretation: "Green" }, { colorInterpretation: "Blue" }],
})

/** What the reprojection produced: the selected bands, then the alpha warp added. */
const warped = (bands: number) =>
  JSON.stringify({
    size: [4011, 4096],
    cornerCoordinates: { lowerLeft: [12538766, 3405322], upperRight: [12806714, 3679950] },
    coordinateSystem: { projjson: { id: { authority: "EPSG", code: 3857 } } },
    bands: [
      ...Array.from({ length: bands }, () => ({ colorInterpretation: "Undefined" })),
      { colorInterpretation: "Alpha" },
    ],
  })

interface Script {
  readonly source: string
  readonly warpedBands: number
  readonly warpSelectsBands?: boolean
  /** The encoder exits zero and leaves nothing behind. */
  readonly encoderLies?: boolean
}

/** The encoder really writes its file, since the pipeline reads it back. */
function scripted(script: Script) {
  const calls = Ref.makeUnsafe<{ command: string; args: readonly string[] }[]>([])
  const answer = (command: string, args: readonly string[]): string => {
    const tool = path.basename(command)
    if (tool === "gdalwarp" && args.includes("--help")) {
      return script.warpSelectsBands === false ? "gdalwarp [-r <method>] src dst" : "[-srcband <band>]..."
    }
    if (tool === "gdalinfo") return args.includes("-approx_stats") ? script.source : warped(script.warpedBands)
    if (tool === "gdal_translate" && args.includes("WEBP") && !script.encoderLies) {
      fs.writeFileSync(args[args.length - 1]!, "webp bytes")
    }
    return ""
  }

  const layer = Layer.succeed(
    GeoRuntime.Service,
    GeoRuntime.Service.of({
      run: (options) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (all) => [...all, { command: options.command, args: options.args }])
          return {
            code: 0,
            reason: "exit",
            stdout: answer(options.command, options.args),
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

const tools = (calls: { command: string }[]) => calls.map((call) => path.basename(call.command))
const flat = (calls: { args: readonly string[] }[]) => calls.map((call) => call.args.join(" "))

describe("gdal raster band choice", () => {
  const info = (json: string) => GdalInspector.parseRaster(json)

  test("a scene that names its bands comes out in true colour", () => {
    expect(GdalRaster.selectBands(info(LANDSAT)).rgb).toEqual([4, 3, 2])
  })

  test("declared colours win over names and over position", () => {
    const declared = GdalRaster.selectBands(
      info(
        JSON.stringify({
          ...georeferenced,
          bands: [
            { colorInterpretation: "Blue", description: "B2" },
            { colorInterpretation: "Green", description: "B3" },
            { colorInterpretation: "Red", description: "B4" },
            { colorInterpretation: "Alpha" },
          ],
        }),
      ),
    )
    // Colour and description both point at 3/2/1 here, so what this rules out is the positional fallback: 4/3/2.
    expect(declared.rgb).toEqual([3, 2, 1])
    expect(declared.alpha).toBe(4)
  })

  test("one measured quantity is drawn from a single band, three times over", () => {
    const single = GdalRaster.selectBands(info(DEM))
    expect(single.rgb).toEqual([1, 1, 1])
    expect(single.alpha).toBeUndefined()
  })

  test("the second band of a grey pair is transparency, not a channel", () => {
    const pair = GdalRaster.selectBands(
      info(
        JSON.stringify({
          ...georeferenced,
          bands: [{ colorInterpretation: "Gray" }, { colorInterpretation: "Undefined" }],
        }),
      ),
    )
    expect(pair.rgb).toEqual([1, 1, 1])
    expect(pair.alpha).toBe(2)
  })

  test("with nothing declared and nothing named, the count decides", () => {
    const anonymous = (count: number) =>
      GdalRaster.selectBands(
        info(JSON.stringify({ ...georeferenced, bands: Array.from({ length: count }, () => ({})) })),
      ).rgb
    expect(anonymous(5)).toEqual([4, 3, 2])
    expect(anonymous(3)).toEqual([1, 2, 3])
  })
})

describe("gdal raster stretch", () => {
  test("the window is a few deviations around the mean, clamped to the data", () => {
    const [low, high] = GdalRaster.stretch({ index: 1, minimum: -138, maximum: 7467, mean: 1762, stdDev: 1712 })
    expect(low).toBe(-138)
    expect(high).toBeCloseTo(1762 + 1712 * 1.8, 3)
  })

  test("a band with no usable statistics still yields a window", () => {
    expect(GdalRaster.stretch({ index: 1, minimum: 5, maximum: 9 })).toEqual([5, 9])
    expect(GdalRaster.stretch({ index: 1, minimum: 5, maximum: 9, mean: 7, stdDev: 0 })).toEqual([5, 9])
    expect(GdalRaster.stretch({ index: 1, minimum: 3, maximum: 3, mean: 3, stdDev: 1 })).toEqual([0, 255])
    expect(GdalRaster.stretch(undefined)).toEqual([0, 255])
  })
})

describe("gdal raster preview size", () => {
  test("a scene is brought under the cap, and a small file is left alone", () => {
    const large = GdalRaster.previewSize(10980, 10980)
    expect(Math.max(large.width, large.height)).toBe(4096)
    expect(large.downscaled).toBe(true)

    expect(GdalRaster.previewSize(640, 480)).toEqual({ width: 640, height: 480, downscaled: false })
  })

  test("the shape survives the reduction", () => {
    const wide = GdalRaster.previewSize(20000, 1000)
    expect(wide.width).toBe(4096)
    expect(wide.height).toBe(205)
  })
})

describe("gdal raster composition", () => {
  test("colour and transparency come from different files", () => {
    const vrt = GdalRaster.rgbaVrt(100, 80, "/cache/coloured.vrt", "/cache/warped.vrt", 2)
    expect(vrt.match(/<VRTRasterBand/g)).toHaveLength(4)
    expect(vrt).toContain("<ColorInterp>Alpha</ColorInterp>")
    const alpha = vrt.slice(vrt.indexOf("Alpha"))
    expect(alpha).toContain("/cache/warped.vrt")
    expect(alpha).toContain("<SourceBand>2</SourceBand>")
  })

  test("a home directory with an ampersand in it does not produce broken XML", () => {
    expect(GdalRaster.rgbaVrt(1, 1, "/a&b/c.vrt", "/a&b/w.vrt", 1)).toContain("/a&amp;b/c.vrt")
  })
})

describe("gdal raster pipeline", () => {
  {
    const script = scripted({ source: DEM, warpedBands: 1 })
    const source = sourceFor("single")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("single-band data is colourized, and its transparency put back", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        const preview = yield* raster.preview(environment, source)
        const calls = yield* Ref.get(script.calls)

        expect(tools(calls)).toContain("gdaldem")
        // Encoding the `gdaldem` output directly would paint nodata in the ramp's bottom colour.
        const encode = calls.find((call) => call.args.includes("WEBP"))!
        expect(encode.args[encode.args.length - 2]).toMatch(/rgba\.vrt$/)
        const composed = fs.readFileSync(encode.args[encode.args.length - 2]!, "utf8")
        expect(composed).toContain("<ColorInterp>Alpha</ColorInterp>")
        expect(composed).toContain("warped.vrt")

        expect(preview.projection).toBe("EPSG:3857")
        expect(preview.bands).toEqual([1, 1, 1])
      }),
    )
  }

  {
    const script = scripted({ source: LANDSAT, warpedBands: 3 })
    const source = sourceFor("multi")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("multi-band data goes straight to the encoder, carrying its mask", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        yield* raster.preview(environment, source)
        const calls = yield* Ref.get(script.calls)

        // Running a colour ramp over a picture would repaint it, not merely cost a step.
        expect(tools(calls)).not.toContain("gdaldem")
        const encode = calls.find((call) => call.args.includes("WEBP"))!
        expect(encode.args.filter((argument) => argument === "-b")).toHaveLength(4)
        expect(encode.args.join(" ")).toContain("-b 4")
        // A window per channel; one shared window would tint the image.
        expect(encode.args.join(" ")).toContain("-scale_3")
      }),
    )
  }

  {
    const script = scripted({ source: LANDSAT, warpedBands: 3 })
    const source = sourceFor("untouched")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("nothing in the pipeline may write beside the user's data", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        yield* raster.preview(environment, source)
        const calls = yield* Ref.get(script.calls)

        // Without GDAL_PAM_ENABLED NO, a read-only preview leaves a statistics sidecar beside the source (§7.6).
        const working = calls.filter((call) => !call.args.includes("--help"))
        expect(working.length).toBeGreaterThan(3)
        for (const call of working) expect(call.args.join(" ")).toContain("GDAL_PAM_ENABLED NO")

        // Overviews are used, never built: building them writes to the user's data (§12).
        expect(tools(calls)).not.toContain("gdaladdo")
        expect(flat(calls).some((line) => line.includes("-ovr AUTO"))).toBe(true)
      }),
    )
  }

  {
    const script = scripted({ source: LANDSAT, warpedBands: 3, warpSelectsBands: false })
    const source = sourceFor("older")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("an older toolchain gets the band selection it cannot do itself", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        yield* raster.preview(environment, source)
        const calls = yield* Ref.get(script.calls)

        // Without the extra step such a build reprojects all twelve bands to draw three.
        const selection = calls.find((call) => call.args.join(" ").includes("selected.vrt"))
        expect(selection?.args.join(" ")).toContain("-b 4 -b 3 -b 2")
        const warp = calls.find((call) => path.basename(call.command) === "gdalwarp" && call.args.includes("-of"))!
        expect(warp.args.join(" ")).toContain("selected.vrt")
      }),
    )
  }

  {
    const script = scripted({ source: PLAIN, warpedBands: 3 })
    const source = sourceFor("screenshot")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("an image that is merely a TIFF is refused before any work", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        const outcome = yield* Effect.result(raster.preview(environment, source))
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure") {
          // The caller branches on `kind` to show this file as a picture rather than a fault (httpapi/groups/geo.ts).
          expect((outcome.failure as GdalRaster.GdalRasterError).kind).toBe("not-geographic")
        }
        const calls = yield* Ref.get(script.calls)
        expect(tools(calls)).toEqual(["gdalinfo"])
        // A real gdalinfo errors on a repeated `-mdd` that this stub would accept (inspector.ts).
        expect(flat(calls)[0]).not.toContain("-mdd")
      }),
    )
  }

  {
    const script = scripted({ source: LANDSAT, warpedBands: 3, encoderLies: true })
    const source = sourceFor("silent")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("an encoder that exits zero and produces nothing is a failure, not a defect", () =>
      Effect.gen(function* () {
        // A full disk ends this way.
        const raster = yield* GdalRaster.make()
        const outcome = yield* Effect.result(raster.preview(environment, source)).pipe(
          Effect.catchDefect(() => Effect.succeed({ _tag: "Defect" as const })),
        )
        expect(outcome._tag).toBe("Failure")
      }),
    )
  }

  {
    const script = scripted({ source: LANDSAT, warpedBands: 3 })
    const source = sourceFor("twice")
    const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, script.layer]]))

    it.live("the second view of a file spawns nothing at all", () =>
      Effect.gen(function* () {
        const raster = yield* GdalRaster.make()
        const first = yield* raster.preview(environment, source)
        const spent = (yield* Ref.get(script.calls)).length

        const again = yield* raster.preview(environment, source)
        expect((yield* Ref.get(script.calls)).length).toBe(spent)
        // The extent too: a cached image whose box was lost lands somewhere plausible and wrong.
        expect(again.extent).toEqual(first.extent)
        expect(again.bytes).toBe(first.bytes)
      }),
    )
  }
})
