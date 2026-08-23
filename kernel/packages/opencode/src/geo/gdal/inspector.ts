export * as GdalInspector from "./inspector"

import { Effect } from "effect"
import { Georeference } from "../georeference"
import { GeoRuntime } from "../runtime"
import type { GdalTypes } from "./types"

/* --- GeoCode: reading what a file is, before deciding what to do with it (docs/GEOKERNEL.md §7.4, §7.5).
 *
 * Both pipelines start here and both need it cheap — this is the light half of the light/heavy split (§7.2), so
 * everything below reads headers and samples and nothing walks a full raster. The parsing is kept out of the
 * subprocess so it can be pinned against real captured output, with no toolchain (gdal-inspector.test.ts). --- */

/** Per-band facts the preview needs: which channel it is, and how to stretch it. */
export interface Band {
  readonly index: number
  /** GDAL's colour interpretation, lowercased: `red`, `gray` (not `grey`), `alpha`, `undefined`. */
  readonly color?: string
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly mean?: number
  readonly stdDev?: number
}

export interface RasterInfo {
  readonly width: number
  readonly height: number
  /** `[minX, minY, maxX, maxY]` in the file's own coordinate system. */
  readonly extent: readonly [number, number, number, number]
  readonly projection?: string
  readonly bandCount: number
  /** True when the data is one measured quantity, so the preview colourizes it. */
  readonly singleBand: boolean
  /** Reported and so far unread: the preview passes `-ovr AUTO` and lets GDAL decide (§7.5). */
  readonly hasOverview: boolean
  readonly georeference: Georeference.Kind
  readonly bands: readonly Band[]
}

export interface VectorInfo {
  /** The engine's own name for the layer, needed verbatim: `vector.ts` puts it into an `-sql` query. */
  readonly name: string
  readonly featureCount: number
  readonly geometryTypes: readonly string[]
  readonly properties: readonly string[]
  readonly projection?: string
}

export class GdalInspectError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = "GdalInspectError"
  }
}

/**
 * Carried by every GDAL subprocess that opens a dataset, here and in `raster.ts`, which is why it is exported
 * rather than copied: `GDAL_PAM_ENABLED NO` stops the library writing computed statistics as a sidecar next to
 * the source data, turning a read-only metadata request into a write to the user's directory (§7.5, §7.6).
 */
export const NO_SIDECARS = ["--config", "GDAL_PAM_ENABLED", "NO"] as const

/** Sampled rather than walked: exact statistics would make this step scale with file size (§7.2, §7.5). */
const APPROXIMATE_STATS = "-approx_stats"

/** Generous for a metadata read; a network-mounted file is the case that needs it. */
const TIMEOUT = "30 seconds"

function json(stdout: string, tool: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
  } catch {
    /* fall through to the same message */
  }
  throw new GdalInspectError(`${tool} did not return readable metadata`)
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The authority code when the file carries one, else the name out of the WKT; real files often have neither. */
export function projectionOf(coordinateSystem: unknown): string | undefined {
  const cs = coordinateSystem as { wkt?: unknown; projjson?: { id?: { authority?: unknown; code?: unknown } } }
  const id = cs?.projjson?.id
  if (typeof id?.authority === "string" && (typeof id.code === "number" || typeof id.code === "string")) {
    return `${id.authority}:${id.code}`
  }
  if (typeof cs?.wkt === "string") {
    return /^(?:GEOGCS|PROJCS|GEOGCRS|PROJCRS)\["([^"]+)"/.exec(cs.wkt)?.[1]
  }
  return undefined
}

/** The six affine coefficients, or undefined for anything that is not them. */
function coefficients(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 6) return undefined
  const parsed = value.map(num)
  return parsed.every((item) => item !== undefined) ? (parsed as number[]) : undefined
}

/** `gdalinfo` leaves `gcps` out entirely when the file has none. */
function gcpCount(value: unknown): number {
  const list = (value as { gcpList?: unknown } | undefined)?.gcpList
  return Array.isArray(list) ? list.length : 0
}

function populated(metadata: unknown, name: string): boolean {
  const found = (metadata as Record<string, unknown> | undefined)?.[name]
  return typeof found === "object" && found !== null && Object.keys(found).length > 0
}

/**
 * Read a raster's metadata out of `gdalinfo -json` output. The RPC and GEOLOCATION domains arrive alongside the
 * default one without being asked for, and asking anyway is not the safe extra it looks: `-mdd` takes one domain
 * and errors on a repeat, so a call naming both fails outright.
 */
export function parseRaster(stdout: string): RasterInfo {
  const raw = json(stdout, "gdalinfo")

  const size = raw.size as unknown[]
  const width = Math.round(num(size?.[0]) ?? 0)
  const height = Math.round(num(size?.[1]) ?? 0)
  if (width <= 0 || height <= 0) throw new GdalInspectError("the raster reports no usable dimensions")

  const corners = raw.cornerCoordinates as { lowerLeft?: unknown[]; upperRight?: unknown[] } | undefined
  const lower = corners?.lowerLeft
  const upper = corners?.upperRight
  const xs = [num(lower?.[0]), num(upper?.[0])]
  const ys = [num(lower?.[1]), num(upper?.[1])]
  if (xs.some((v) => v === undefined) || ys.some((v) => v === undefined)) {
    throw new GdalInspectError("the raster reports no usable extent")
  }
  const extent = [
    Math.min(xs[0]!, xs[1]!),
    Math.min(ys[0]!, ys[1]!),
    Math.max(xs[0]!, xs[1]!),
    Math.max(ys[0]!, ys[1]!),
  ] as const

  const rawBands = Array.isArray(raw.bands) ? (raw.bands as Record<string, unknown>[]) : []
  const bands: Band[] = rawBands.map((band, index) => ({
    index: index + 1,
    color: typeof band.colorInterpretation === "string" ? band.colorInterpretation.toLowerCase() : undefined,
    description: typeof band.description === "string" ? band.description : undefined,
    minimum: num(band.minimum),
    maximum: num(band.maximum),
    mean: num(band.mean),
    stdDev: num(band.stdDev),
  }))

  const bandCount = Math.max(1, bands.length)
  // Grey plus alpha colourizes the way one band does: the second band is transparency, not a second channel.
  const singleBand = bandCount === 1 || (bandCount <= 2 && bands[0]?.color === "gray")

  const hasOverview = rawBands.some((band) => Array.isArray(band.overviews) && band.overviews.length > 0)

  const projection = projectionOf(raw.coordinateSystem)
  // Five facts reported, one verdict reached in `georeference.ts` — the two pipelines share that one (§7.9).
  const georeference = Georeference.of({
    transform: coefficients(raw.geoTransform),
    projection: projection !== undefined,
    gcpCount: gcpCount(raw.gcps),
    rpc: populated(raw.metadata, "RPC"),
    geolocation: populated(raw.metadata, "GEOLOCATION"),
  })

  return { width, height, extent, projection, bandCount, singleBand, hasOverview, georeference, bands }
}

/** Read a vector layer's metadata out of `ogrinfo -json -so` output. */
export function parseVector(stdout: string): VectorInfo {
  const raw = json(stdout, "ogrinfo")
  const layers = Array.isArray(raw.layers) ? (raw.layers as Record<string, unknown>[]) : []
  const layer = layers[0]
  if (!layer) throw new GdalInspectError("the file holds no vector layer")

  const geometryFields = Array.isArray(layer.geometryFields) ? (layer.geometryFields as Record<string, unknown>[]) : []
  const geometryTypes = [
    ...new Set(geometryFields.map((field) => field.type).filter((type): type is string => typeof type === "string")),
  ]
  const fields = Array.isArray(layer.fields) ? (layer.fields as Record<string, unknown>[]) : []
  const properties = fields.map((field) => field.name).filter((name): name is string => typeof name === "string")

  return {
    name: typeof layer.name === "string" ? layer.name : "",
    featureCount: num(layer.featureCount) ?? 0,
    geometryTypes,
    properties,
    projection: projectionOf(geometryFields[0]?.coordinateSystem),
  }
}

/**
 * A pure reader, lifted into the error channel: the parsers throw the way ordinary functions do, and a throw
 * left alone inside an Effect is a defect — outside the declared error type, so no caller handling the error
 * channel will see it.
 */
const parsed = <A>(reader: (stdout: string) => A) =>
  Effect.fnUntraced(function* (stdout: string) {
    return yield* Effect.try({
      try: () => reader(stdout),
      catch: (error) =>
        error instanceof GdalInspectError ? error : new GdalInspectError(String((error as Error)?.message ?? error)),
    })
  })

const run = (
  environment: GdalTypes.Environment,
  command: string,
  args: readonly string[],
  label: string,
): Effect.Effect<string, GdalInspectError, GeoRuntime.Service> =>
  Effect.gen(function* () {
    const runtime = yield* GeoRuntime.Service
    const result = yield* runtime
      .run({
        command,
        args,
        env: environment.env,
        delivery: { mode: "collect" },
        clocks: { total: TIMEOUT },
        label,
      })
      .pipe(Effect.mapError((error) => new GdalInspectError(`${label} could not be started: ${error.message}`)))
    if (result.code !== 0) {
      return yield* Effect.fail(new GdalInspectError(`${label} exited with ${result.code ?? "no code"}`, result.stderr))
    }
    return result.stdout
  })

export const inspectRaster = (environment: GdalTypes.Environment, file: string) =>
  run(
    environment,
    environment.tools.gdalinfo,
    [...NO_SIDECARS, "-json", APPROXIMATE_STATS, file],
    "gdal:inspect-raster",
  ).pipe(Effect.flatMap(parsed(parseRaster)))

/**
 * The same shape without `APPROXIMATE_STATS`, for reading back an intermediate the pipeline just produced. Its
 * one caller hands it a virtual dataset, so sampling here would not be a cheap extra — it would run the
 * reprojection early, on top of running it again at encode time.
 */
export const inspectLayout = (environment: GdalTypes.Environment, file: string) =>
  run(environment, environment.tools.gdalinfo, [...NO_SIDECARS, "-json", file], "gdal:inspect-layout").pipe(
    Effect.flatMap(parsed(parseRaster)),
  )

export const inspectVector = (environment: GdalTypes.Environment, file: string) =>
  run(environment, environment.tools.ogrinfo, [...NO_SIDECARS, "-json", "-so", file], "gdal:inspect-vector").pipe(
    Effect.flatMap(parsed(parseVector)),
  )

/**
 * Whether this build of `gdalwarp` can select bands itself; older ones cannot, and `raster.ts` inserts a separate
 * band-selection step for them. Asked of the binary, because a version-to-feature mapping is a second thing to
 * get wrong and users install whatever their platform ships.
 */
export function warpSelectsBands(help: string): boolean {
  // A token boundary rather than a fixed spelling: GDAL 3.13.3 prints `[-srcband <band>]...`, and builds that
  // spell the same flag `-b` put it in brackets; a check tuned to one answers "no" for the other.
  return /(^|[\s[])-b[\s<]/.test(help) || help.includes("-srcband")
}

export const probeWarpBands = (environment: GdalTypes.Environment) =>
  run(environment, environment.tools.gdalwarp, ["--help"], "gdal:probe-warp").pipe(
    Effect.map(warpSelectsBands),
    // `--help` exits non-zero on some builds, so a probe that could not run answers no: an extra pass the
    // toolchain may not have needed, rather than a flag it may not have.
    Effect.catch(() => Effect.succeed(false)),
  )
