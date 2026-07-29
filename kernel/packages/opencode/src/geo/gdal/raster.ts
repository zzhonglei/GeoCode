export * as GdalRaster from "./raster"

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Duration, Effect, Scope } from "effect"
import { GeoRuntime } from "../runtime"
import { GdalCache } from "./cache"
import { GdalInspector } from "./inspector"
import type { GdalTypes } from "./types"

/* --- GeoCode: turning a raster into something a web map can draw
 * (docs/GEOKERNEL.md §7.5).
 *
 * A scene is tens of thousands of pixels across, in a coordinate system no web
 * map uses, holding measurements rather than colours. The interface receives
 * none of that: it gets an image, already in web mercator, already small enough
 * to hand to a canvas, and the geographic box to put it in.
 *
 * **Nothing here writes beside the source data, and nothing here builds
 * overviews.** The first is why every tool call carries `NO_SIDECARS`; the
 * second is a measured result rather than an omission — building them costs one
 * full read of the source, which is exactly the read the reprojection already
 * performs, so the optimization is never positive for a one-shot preview
 * (§7.5, §12).
 *
 * Everything between the source and the encoder is a **virtual dataset**: an
 * XML file describing what to compute, never a copy of the pixels. The whole
 * chain therefore costs one read, at the end, and the intermediates cost
 * kilobytes inside this file's own cache directory. --- */

/** What every consumer receives, whatever the source was projected in. */
const TARGET_CRS = "EPSG:3857"

/**
 * The two caps on preview size, applied together, and only ever downwards.
 *
 * With these values the side cap always binds first — the pixel cap is the
 * side cap squared, so it can only bind on an image whose longest side is
 * shorter than its own square root, which no image is. It is kept because the
 * pair is the contract (§7.5): raise the side cap alone and the second one
 * starts doing its job.
 */
const MAX_SIDE = 4096
const MAX_PIXELS = 16_777_216

/** Multiples of the standard deviation kept on each side of the mean. */
const STRETCH_SIGMA = 1.8

/**
 * The colour ramp for single-band data, five stops over the stretched range.
 *
 * Blue → teal → green → orange → cream, interpolated linearly between stops.
 * It applies to the DATA-PLANE preview only: the tool-side preview (§7.9) hands
 * the model a grey image, and deliberately so — the model reads values, a
 * person reads a picture. The two pipelines share band selection, stretch and
 * transparency; colour is not among them.
 */
const COLORMAP = ["0 18 38 86", "64 34 94 168", "128 55 148 110", "192 215 155 78", "255 246 236 189"].join("\n") + "\n"

const QUALITY = "QUALITY=75"

/** Building a virtual dataset reads headers only; no pixel is touched. */
const PLAN_TIMEOUT = "60 seconds"

/** The single pass that does read pixels — the whole cost of a preview lands here. */
const ENCODE_TIMEOUT = "180 seconds"

export interface Meta {
  /**
   * Whether this is geographic data at all.
   *
   * The interface needs it separately from the rest: a plain image saved as
   * `.tif` has a width and a band count like anything else, and the honest
   * response is to show it as an image rather than to place it on a map.
   */
  readonly geographic: boolean
  readonly projection?: string
  readonly width: number
  readonly height: number
  readonly bandCount: number
}

export interface Preview {
  /** Where the encoded image is. Bytes stay on disk; the caller streams them. */
  readonly image: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly projection: string
  /**
   * `[minX, minY, maxX, maxY]` in `projection` — where to put the image.
   *
   * The reprojected box, not the source's. Handing over the source extent
   * would place the image by coordinates that mean nothing in the system it
   * was drawn in, which looks like data in the wrong country.
   */
  readonly extent: readonly [number, number, number, number]
  /** The source bands behind red, green and blue, for the interface to report. */
  readonly bands: readonly number[]
  /** True when a cap bound, so the interface can say this is not full resolution. */
  readonly downscaled: boolean
}

export class GdalRasterError extends Error {
  constructor(
    message: string,
    readonly kind: "not-geographic" | "preview-failed",
  ) {
    super(message)
    this.name = "GdalRasterError"
  }
}

export interface Selection {
  readonly rgb: readonly [number, number, number]
  readonly alpha?: number
}

/**
 * Which bands become red, green and blue, and which one is transparency.
 *
 * Four rules in order of how much the file actually told us: a declared alpha
 * channel, declared colour interpretation, band names, and finally the band
 * count alone. The named case is what makes satellite imagery come out in true
 * colour — a Landsat scene declares no colours but names its bands, and B4/B3/B2
 * is red/green/blue while the first three bands are not.
 *
 * Shared with the tool-side preview by definition, not by code (§7.9): the same
 * four rules exist in `qgis/scripts/raster_preview.py`, and the two must not
 * drift.
 */
export function selectBands(info: GdalInspector.RasterInfo): Selection {
  const declared = info.bands.find((band) => band.color === "alpha")?.index
  const named = (n: number) =>
    info.bands.find((band) => {
      const text = band.description?.trim().toUpperCase()
      return text === `B${n}` || text === `B0${n}` || text === `BAND ${n}`
    })?.index

  // One measured quantity: the same band three times, then colourized. The
  // second band of a grey pair is transparency, so it is the alpha by default.
  if (info.singleBand) return { rgb: [1, 1, 1], alpha: declared ?? (info.bandCount >= 2 ? 2 : undefined) }

  const red = info.bands.find((band) => band.color === "red")?.index
  const green = info.bands.find((band) => band.color === "green")?.index
  const blue = info.bands.find((band) => band.color === "blue")?.index
  if (red && green && blue) return { rgb: [red, green, blue], alpha: declared }

  const [fourth, third, second] = [named(4), named(3), named(2)]
  if (fourth && third && second) return { rgb: [fourth, third, second], alpha: declared }

  if (info.bandCount >= 4) return { rgb: [4, 3, 2], alpha: declared }
  if (info.bandCount >= 3) return { rgb: [1, 2, 3], alpha: declared }
  if (info.bandCount === 2) return { rgb: [1, 1, 1], alpha: 2 }
  return { rgb: [1, 1, 1] }
}

/**
 * The value range that becomes 0–255.
 *
 * Not the full range: a single lightning-bright pixel or one nodata outlier
 * would flatten everything else into the bottom of the scale. Keeping to a few
 * standard deviations around the mean is what makes an ordinary scene readable,
 * and the clamp to the real min/max keeps the window inside the data. The
 * fallbacks matter more than they look — a constant band, or one whose
 * statistics are missing, must still produce SOME window rather than a division
 * by zero.
 */
export function stretch(band: GdalInspector.Band | undefined): readonly [number, number] {
  const minimum = band?.minimum
  const maximum = band?.maximum
  if (minimum === undefined || maximum === undefined || maximum <= minimum) return [0, 255]

  const mean = band?.mean
  const deviation = band?.stdDev
  if (mean === undefined || deviation === undefined || deviation <= 0) return [minimum, maximum]

  const low = Math.max(minimum, mean - deviation * STRETCH_SIGMA)
  const high = Math.min(maximum, mean + deviation * STRETCH_SIGMA)
  return high > low ? [low, high] : [minimum, maximum]
}

/** The preview's dimensions: both caps at once, never an enlargement. */
export function previewSize(width: number, height: number) {
  const ratio = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  const scaled = { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
  return { ...scaled, downscaled: scaled.width !== width || scaled.height !== height }
}

/** A path is about to become XML content, and a home directory may contain `&`. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Four bands: colour from one dataset, transparency from another.
 *
 * **This is the whole reason single-band previews are not three tool calls.**
 * Colourizing produces a three-band image and drops the alpha with it, so the
 * nodata that the reprojection carefully marked would come back as a real
 * colour — the ramp's bottom stop, painted over every part of the scene that
 * holds no data. Stitching the mask back on is what keeps those areas
 * transparent, and there is no flag that does it.
 */
export function rgbaVrt(width: number, height: number, colour: string, mask: string, maskBand: number): string {
  const rect = `<SrcRect xOff="0" yOff="0" xSize="${width}" ySize="${height}"/><DstRect xOff="0" yOff="0" xSize="${width}" ySize="${height}"/>`
  const source = (file: string, band: number) =>
    `<SimpleSource><SourceFilename relativeToVRT="0">${escapeXml(file)}</SourceFilename><SourceBand>${band}</SourceBand>${rect}</SimpleSource>`
  const colours = (["Red", "Green", "Blue"] as const).map(
    (name, index) =>
      `\n  <VRTRasterBand dataType="Byte" band="${index + 1}"><ColorInterp>${name}</ColorInterp>${source(colour, index + 1)}</VRTRasterBand>`,
  )
  return `<VRTDataset rasterXSize="${width}" rasterYSize="${height}">${colours.join("")}
  <VRTRasterBand dataType="Byte" band="4"><ColorInterp>Alpha</ColorInterp>${source(mask, maskBand)}</VRTRasterBand>
</VRTDataset>
`
}

interface Rasters {
  readonly meta: (environment: GdalTypes.Environment, file: string) => Effect.Effect<Meta, Error, GeoRuntime.Service>
  readonly preview: (
    environment: GdalTypes.Environment,
    file: string,
  ) => Effect.Effect<Preview, Error, GeoRuntime.Service>
}

/**
 * The raster pipeline, holding the merge that keeps concurrent callers to one
 * production.
 *
 * A preview is seconds of subprocess work, and the interface asks twice more
 * easily than it looks — a click, a re-render, two panels on one layer. The
 * merge belongs to the module rather than to the first caller, so a browser tab
 * closing does not cancel the image two other viewers are waiting for (§7.6).
 */
export const make = (): Effect.Effect<Rasters, never, Scope.Scope> =>
  Effect.gen(function* () {
    const merge = yield* GdalCache.merger<Preview, Error>()

    const run = (
      environment: GdalTypes.Environment,
      command: string,
      args: readonly string[],
      total: Duration.Input,
      label: string,
    ) =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const result = yield* runtime
          .run({ command, args, env: environment.env, delivery: { mode: "collect" }, clocks: { total }, label })
          .pipe(
            Effect.mapError(
              (error) => new GdalRasterError(`${label} could not be started: ${error.message}`, "preview-failed"),
            ),
          )
        if (result.code !== 0) {
          return yield* Effect.fail(
            new GdalRasterError(
              `${label} exited with ${result.code ?? "no code"}: ${result.stderr.trim()}`,
              "preview-failed",
            ),
          )
        }
        return result
      })

    const artifacts = (environment: GdalTypes.Environment, file: string) => {
      const key = GdalCache.key(GdalCache.describe(file), environment.fingerprint)
      const directory = GdalCache.directory("raster", key)
      return {
        key,
        directory,
        image: path.join(directory, "preview.webp"),
        record: path.join(directory, "preview.json"),
      }
    }

    const produce = (environment: GdalTypes.Environment, file: string, places: ReturnType<typeof artifacts>) =>
      Effect.gen(function* () {
        const info = yield* GdalInspector.inspectRaster(environment, file)
        if (!info.geographic) {
          return yield* Effect.fail(
            new GdalRasterError(
              "this file carries no coordinate system, so it is an image rather than geographic data",
              "not-geographic",
            ),
          )
        }

        const size = previewSize(info.width, info.height)
        const choice = selectBands(info)
        const selected = [...new Set([...choice.rgb, ...(choice.alpha ? [choice.alpha] : [])])]
        // Where a source band lands once the selection renumbers from 1. It
        // cannot miss: `selected` is built from exactly the bands asked about.
        const position = (band: number) => selected.indexOf(band) + 1
        const bandOf = (index: number) => info.bands.find((band) => band.index === index)

        mkdirSync(places.directory, { recursive: true })

        // Older builds cannot select bands while warping, and would otherwise
        // reproject all twelve bands of a scene to draw three of them.
        const warpSelects = yield* GdalInspector.probeWarpBands(environment)
        const chosen = warpSelects ? file : path.join(places.directory, "selected.vrt")
        if (!warpSelects) {
          yield* run(
            environment,
            environment.tools.gdal_translate,
            [
              ...GdalInspector.NO_SIDECARS,
              "-of",
              "VRT",
              ...selected.flatMap((band) => ["-b", String(band)]),
              file,
              chosen,
            ],
            PLAN_TIMEOUT,
            "gdal:raster-select",
          )
        }

        const warped = path.join(places.directory, "warped.vrt")
        yield* run(
          environment,
          environment.tools.gdalwarp,
          [
            ...GdalInspector.NO_SIDECARS,
            "-overwrite",
            "-of",
            "VRT",
            "-t_srs",
            TARGET_CRS,
            "-r",
            "bilinear",
            // Marks where there is no data, and is the ONLY thing that does.
            // Everything downstream either carries this band or loses nodata.
            "-dstalpha",
            ...(warpSelects ? selected.flatMap((band) => ["-b", String(band)]) : []),
            "-ts",
            String(size.width),
            String(size.height),
            // Use overviews the file already carries; never build any (§7.5).
            "-ovr",
            "AUTO",
            chosen,
            warped,
          ],
          PLAN_TIMEOUT,
          "gdal:raster-warp",
        )

        // Layout only: this is a virtual dataset, so asking for statistics here
        // would run the reprojection early and then again at encode time.
        const placed = yield* GdalInspector.inspectLayout(environment, warped)
        const mask = placed.bands.find((band) => band.color === "alpha")?.index ?? selected.length + 1
        // One window per channel. Single-band data asks the same band three
        // times over, so all three are the same and only the first is used.
        const windows = choice.rgb.map((band) => stretch(bandOf(band)))

        if (info.singleBand) {
          const [low, high] = windows[0]!
          const grey = path.join(places.directory, "grey.vrt")
          const coloured = path.join(places.directory, "coloured.vrt")
          const composed = path.join(places.directory, "rgba.vrt")
          const colormap = path.join(places.directory, "colormap.txt")
          writeFileSync(colormap, COLORMAP, "utf8")

          yield* run(
            environment,
            environment.tools.gdal_translate,
            [
              ...GdalInspector.NO_SIDECARS,
              "-of",
              "VRT",
              "-b",
              String(position(choice.rgb[0])),
              "-scale_1",
              String(low),
              String(high),
              "0",
              "255",
              "-ot",
              "Byte",
              warped,
              grey,
            ],
            PLAN_TIMEOUT,
            "gdal:raster-grey",
          )
          yield* run(
            environment,
            environment.tools.gdaldem,
            ["color-relief", ...GdalInspector.NO_SIDECARS, "-of", "VRT", grey, colormap, coloured],
            PLAN_TIMEOUT,
            "gdal:raster-colour",
          )
          writeFileSync(composed, rgbaVrt(size.width, size.height, coloured, warped, mask), "utf8")
          yield* run(
            environment,
            environment.tools.gdal_translate,
            [...GdalInspector.NO_SIDECARS, "-of", "WEBP", "-co", QUALITY, composed, places.image],
            ENCODE_TIMEOUT,
            "gdal:raster-encode",
          )
        } else {
          yield* run(
            environment,
            environment.tools.gdal_translate,
            [
              ...GdalInspector.NO_SIDECARS,
              "-of",
              "WEBP",
              "-co",
              QUALITY,
              // The encoder takes bytes only. Without this the conversion still
              // happens, but behind a warning that reads like a fault.
              "-ot",
              "Byte",
              ...choice.rgb.flatMap((band) => ["-b", String(position(band))]),
              // Transparency rides along as the fourth band, unscaled — it is
              // already a mask, not a measurement.
              "-b",
              String(mask),
              ...windows.flatMap(([from, to], index) => [`-scale_${index + 1}`, String(from), String(to), "0", "255"]),
              warped,
              places.image,
            ],
            ENCODE_TIMEOUT,
            "gdal:raster-encode",
          )
        }

        // A zero exit is the encoder's opinion, not evidence. A full disk or a
        // driver that declined the data leaves nothing behind, and reading the
        // size of a file that is not there would raise a DEFECT — outside the
        // error channel, uncatchable by the caller whose honest answer is that
        // the preview could not be made.
        if (!existsSync(places.image)) {
          return yield* Effect.fail(
            new GdalRasterError("the encoder reported success but left no image behind", "preview-failed"),
          )
        }

        const preview: Preview = {
          image: places.image,
          bytes: statSync(places.image).size,
          width: size.width,
          height: size.height,
          projection: TARGET_CRS,
          extent: placed.extent,
          bands: choice.rgb,
          downscaled: size.downscaled,
        }
        writeFileSync(places.record, JSON.stringify(preview), "utf8")
        return preview
      })

    const meta: Rasters["meta"] = (environment, file) =>
      GdalInspector.inspectRaster(environment, file).pipe(
        Effect.map((info) => ({
          geographic: info.geographic,
          projection: info.projection,
          width: info.width,
          height: info.height,
          bandCount: info.bandCount,
        })),
      )

    const preview: Rasters["preview"] = (environment, file) =>
      Effect.gen(function* () {
        const places = artifacts(environment, file)
        const done = kept(places)
        if (done) return done

        // The production is handed the runtime rather than inheriting it: it
        // runs on the module's fiber, where the caller's context is gone.
        const runtime = yield* GeoRuntime.Service
        return yield* merge(
          places.key,
          produce(environment, file, places).pipe(Effect.provideService(GeoRuntime.Service, runtime)),
        )
      })

    return { meta, preview }
  })

/**
 * A finished preview from an earlier request, or nothing.
 *
 * The extent is what gets checked, because it is the field whose loss is
 * silent: an image placed by a missing box lands somewhere plausible and wrong,
 * while a missing size or byte count would be obvious immediately.
 */
function kept(places: { image: string; record: string }): Preview | undefined {
  if (!existsSync(places.image) || !existsSync(places.record)) return undefined
  try {
    const record = JSON.parse(readFileSync(places.record, "utf8"))
    if (!Array.isArray(record?.extent) || record.extent.length !== 4) return undefined
    return record as Preview
  } catch {
    return undefined
  }
}
