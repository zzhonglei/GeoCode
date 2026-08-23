export * as GdalRaster from "./raster"

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Duration, Effect, Scope } from "effect"
import type { Georeference } from "../georeference"
import { GeoRuntime } from "../runtime"
import { GdalCache } from "./cache"
import { GdalInspector } from "./inspector"
import type { GdalTypes } from "./types"

/* --- GeoCode: turning a raster into something a web map can draw (docs/GEOKERNEL.md §7.5).
 *
 * Nothing here writes beside the source data — every tool call carries `NO_SIDECARS` — and nothing here builds
 * overviews (§7.5, §12). Every intermediate is a virtual dataset, XML describing what to compute rather than a
 * copy of the pixels, so the encode at the end is the only full read. --- */

const TARGET_CRS = "EPSG:3857"

/**
 * Both caps, applied together and only ever downwards. `MAX_PIXELS` is `MAX_SIDE` squared, so with these values
 * the side cap always binds first: width × height can never exceed the longer side squared. The pair is still
 * the contract (§7.5) — raise `MAX_SIDE` alone and the pixel cap starts binding.
 */
const MAX_SIDE = 4096
const MAX_PIXELS = 16_777_216

const STRETCH_SIGMA = 1.8

/** `value R G B` per line over the 0–255 the grey step produces; `gdaldem` interpolates between the stops. Data
 * plane only — the tool face hands the model a grey image on purpose, so colour is not a shared rule (§7.9). */
const COLORMAP = ["0 18 38 86", "64 34 94 168", "128 55 148 110", "192 215 155 78", "255 246 236 189"].join("\n") + "\n"

const QUALITY = "QUALITY=75"

/** Building a virtual dataset reads headers only; no pixel is touched. */
const PLAN_TIMEOUT = "60 seconds"

/** The one pass that reads pixels — the whole cost of a preview lands here. */
const ENCODE_TIMEOUT = "180 seconds"

export interface Meta {
  readonly georeference: Georeference.Kind
  readonly projection?: string
  readonly width: number
  readonly height: number
  readonly bandCount: number
}

export interface Preview {
  /** A path; the handler reads the file when it builds the response. */
  readonly image: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly projection: string
  /** `[minX, minY, maxX, maxY]` in `projection` — the reprojected box, never the source's. */
  readonly extent: readonly [number, number, number, number]
  /** Source band numbers, not the positions the encode renumbers them to. */
  readonly bands: readonly number[]
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
 * Which bands become red, green and blue, and which one is transparency. The same four rules exist again in
 * `qgis/scripts/raster_preview.py`; `test/geo/raster-rules.test.ts` runs both faces over one list of cases so
 * they cannot drift (§7.9).
 */
export function selectBands(info: GdalInspector.RasterInfo): Selection {
  const declared = info.bands.find((band) => band.color === "alpha")?.index
  const named = (n: number) =>
    info.bands.find((band) => {
      const text = band.description?.trim().toUpperCase()
      return text === `B${n}` || text === `B0${n}` || text === `BAND ${n}`
    })?.index

  // The same band three times, then colourized; a grey pair's second band is transparency, so it is the alpha.
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
 * The window that becomes 0–255: a few sigma around the mean rather than the full range, so one outlier cannot
 * flatten the rest of the scale into the bottom of it. No `isfinite` guard where the Python twin has one —
 * everything reaching here came through the inspector's `num()` and is finite already (§7.9).
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

export function previewSize(width: number, height: number) {
  const ratio = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  const scaled = { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
  return { ...scaled, downscaled: scaled.width !== width || scaled.height !== height }
}

/** For element text only — quotes are not escaped. A home directory may well contain `&`. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Four bands: colour from one dataset, transparency from another. `gdaldem color-relief` emits three bands and
 * drops the warp's alpha with them, so nodata would come back as the ramp's bottom stop painted over every part
 * of the scene that holds none; band 4 is that mask, read back off the warped dataset.
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
        if (info.georeference === "none") {
          return yield* Effect.fail(
            new GdalRasterError(
              "this file carries no georeferencing, so it is an image rather than geographic data",
              "not-geographic",
            ),
          )
        }

        const size = previewSize(info.width, info.height)
        const choice = selectBands(info)
        const selected = [...new Set([...choice.rgb, ...(choice.alpha ? [choice.alpha] : [])])]
        // Where a source band lands once the selection renumbers from 1.
        const position = (band: number) => selected.indexOf(band) + 1
        const bandOf = (index: number) => info.bands.find((band) => band.index === index)

        mkdirSync(places.directory, { recursive: true })

        // Older builds cannot select bands while warping, and would otherwise reproject every band to draw three.
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
            // The only thing marking where there is no data; everything downstream carries this band or loses it.
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

        const placed = yield* GdalInspector.inspectLayout(environment, warped)
        const mask = placed.bands.find((band) => band.color === "alpha")?.index ?? selected.length + 1
        // One window per channel; single-band data asks the same band three times, so only the first is used.
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
              // The WEBP driver takes Byte only: without this it still converts, behind a warning that reads
              // like a failure.
              "-ot",
              "Byte",
              ...choice.rgb.flatMap((band) => ["-b", String(position(band))]),
              // Transparency rides along as the fourth band, unscaled — it is a mask, not a measurement.
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

        // A zero exit is the encoder's opinion, not evidence: `statSync` below on a file a full disk left
        // unwritten would throw a defect, outside the error channel the caller can answer for.
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
          georeference: info.georeference,
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

        // `merger` takes an effect with no requirements and forks it into its own scope, so the runtime is
        // handed over here rather than inherited.
        const runtime = yield* GeoRuntime.Service
        return yield* merge(
          places.key,
          produce(environment, file, places).pipe(Effect.provideService(GeoRuntime.Service, runtime)),
        )
      })

    return { meta, preview }
  })

/**
 * A finished preview from an earlier request, or nothing. The extent is the field checked because its loss is
 * the silent one: an image placed by a missing box lands somewhere plausible and wrong, where a missing size
 * shows immediately.
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
