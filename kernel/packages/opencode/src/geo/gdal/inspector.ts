export * as GdalInspector from "./inspector"

import { Effect } from "effect"
import { GeoRuntime } from "../runtime"
import type { GdalTypes } from "./types"

/* --- GeoCode: reading what a file is, before deciding what to do with it
 * (docs/GEOKERNEL.md §7.4, §7.5).
 *
 * Both pipelines start here, and both need this step to stay CHEAP — it is the
 * "light" half of the light/heavy split that lets the interface draw a skeleton
 * before any pixels exist (§7.2). Everything below reads headers and samples;
 * nothing walks a full raster.
 *
 * The parsing is separated from the subprocess on purpose. What the tools emit
 * is the part that drifts between versions, and a pure function over their
 * output can be pinned against real captured output without a toolchain being
 * installed. --- */

/** Per-band facts the preview needs: which channel it is, and how to stretch it. */
export interface Band {
  readonly index: number
  /** Lowercased colour interpretation, e.g. `red`, `gray`, `alpha`, `undefined`. */
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
  /** Overviews the file already carries. Free speed when present; never built (§7.5). */
  readonly hasOverview: boolean
  /**
   * Whether this is geographic data at all.
   *
   * A TIFF is not necessarily a raster dataset — a screenshot saved as `.tif`
   * parses perfectly and carries no georeferencing. Letting one into the
   * pipeline produces a reprojection of nothing onto nowhere, so the answer is
   * decided here and the pipeline is never entered (§7.5).
   */
  readonly geographic: boolean
  readonly bands: readonly Band[]
}

export interface VectorInfo {
  /**
   * The layer name the engine knows it by.
   *
   * Needed verbatim to query the layer later. Deriving it from the filename
   * is right often enough to look correct and wrong often enough to matter —
   * and it is right here in the output, so guessing is a choice.
   */
  readonly name: string
  readonly featureCount: number
  /**
   * The geometry types present.
   *
   * A HARD contract for the interface: it picks a renderer from this, and a
   * point-only layer takes a path that the general one cannot match. Reporting
   * it wrong is not a cosmetic error (§7.4).
   */
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
 * Carried by **every** GDAL subprocess in this module, not only these.
 *
 * `GDAL_PAM_ENABLED NO` stops the library writing computed statistics as a
 * sidecar **next to the source data**. Without it a read-only preview request
 * silently modifies the user's directory — the same class of problem that cost
 * the overview step its existence (§7.6).
 *
 * Exported because that rule is module-wide: the raster pipeline runs four more
 * tools over the same source, and a copy of this array in each file is a copy
 * that can be forgotten in one of them.
 */
export const NO_SIDECARS = ["--config", "GDAL_PAM_ENABLED", "NO"] as const

/**
 * Sample rather than walk every pixel.
 *
 * Exact statistics would make this step scale with file size, which is
 * precisely what the light/heavy split exists to avoid (§7.2), and the stretch
 * they feed is not sensitive to the difference.
 */
const APPROXIMATE_STATS = "-approx_stats"

/** Generous for a header read; a network-mounted file is the case that needs it. */
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

/**
 * A coordinate system's short identifier.
 *
 * The authority code when the file carries one, because that is what a caller
 * can act on; otherwise the human name out of the WKT, which at least says
 * where the data thinks it is. Neither is guaranteed — plenty of real files
 * have no coordinate system at all, and `undefined` is the honest answer.
 */
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

/** Read a raster's metadata out of `gdalinfo -json` output. */
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
  // Two bands where the first is grey is grey-plus-alpha, which colourizes the
  // same way one band does — the second band is transparency, not a channel.
  const singleBand = bandCount === 1 || (bandCount <= 2 && bands[0]?.color === "gray")

  // Any band reporting overviews counts. GDAL keeps them in lockstep across
  // bands, so this is the same answer as checking the first, and it survives
  // the odd file where it is not.
  const hasOverview = rawBands.some((band) => Array.isArray(band.overviews) && band.overviews.length > 0)

  const projection = projectionOf(raw.coordinateSystem)
  // No coordinate system AND an extent that is exactly the pixel grid: this is
  // an image that happens to be a TIFF, not a raster dataset.
  const pixelSpace = extent[0] === 0 && extent[1] === 0 && extent[2] === width && extent[3] === height
  const geographic = !!projection && !pixelSpace

  return { width, height, extent, projection, bandCount, singleBand, hasOverview, geographic, bands }
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
 * A pure reader, lifted into the error channel.
 *
 * The parsers throw because they are ordinary functions and that is how
 * ordinary functions refuse. Left alone inside an Effect that becomes a
 * DEFECT — outside the declared error type, uncatchable by every caller, and
 * fatal to a request whose honest answer was "this file is not readable".
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
 * The same shape, without paying for statistics.
 *
 * For reading back an intermediate the pipeline just produced, where the
 * questions are "where did it land" and "how many bands came out" — neither of
 * which needs a single pixel read. Asking for statistics here would not be a
 * cheap extra: the intermediate is a virtual dataset, so sampling it forces the
 * reprojection to run early, on top of running again at encode time.
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
 * Whether this build of `gdalwarp` can select bands itself.
 *
 * Older builds cannot, and the raster pipeline has to insert a separate
 * band-selection step for them. Asked of the binary rather than assumed from a
 * version string: the flag is what matters, version-to-feature mapping is a
 * second thing to get wrong, and users install whatever their platform ships.
 */
export function warpSelectsBands(help: string): boolean {
  // Matched on a token boundary rather than a fixed spelling: builds differ on
  // whether the flag appears as `-b <band>` or `[-b <band>]`, and a substring
  // check tuned to one of those silently answers "no" for the other — which
  // costs the pipeline an extra pass on a toolchain that never needed it.
  return /(^|[\s[])-b[\s<]/.test(help) || help.includes("-srcband")
}

export const probeWarpBands = (environment: GdalTypes.Environment) =>
  run(environment, environment.tools.gdalwarp, ["--help"], "gdal:probe-warp").pipe(
    Effect.map(warpSelectsBands),
    // `--help` exits non-zero on some builds. Not being able to ask is not the
    // same as the answer being no, but the safe reading is the one that still
    // works everywhere: take the extra step.
    Effect.catch(() => Effect.succeed(false)),
  )
