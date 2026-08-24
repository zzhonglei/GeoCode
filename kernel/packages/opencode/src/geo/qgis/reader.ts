export * as QgisReader from "./reader"

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { Duration } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisBootstrap } from "./bootstrap"
import { RASTER_PREVIEW_PY, RASTER_READ_PY, VECTOR_READ_PY } from "./scripts.generated"
import type { Environment } from "./types"

/* --- GeoCode: the data-reading pipeline (docs/GEOKERNEL.md §4.13).
 *
 * Pure functions over an environment the gate verified (§4.9, §9.1), stateless between calls. The scripts travel as
 * generated constants and run MATERIALIZED, never inline: the vector script alone is 23KB, about three quarters of
 * the Windows command-line limit (§4.13 校准量). --- */

/** One marker for the whole family; each script embeds the same string. */
export const MARKER = "__GEOCODE_READ_JSON__"

/**
 * Total clocks, not idle: no script here emits progress, so a full-table
 * statistics scan is silent for its whole runtime (§8.4 — these are the kernel-known tier).
 */
const VECTOR_TOTAL = "120 seconds" // twice the raster bound: GeoJSON/GML drivers parse the whole file at open
const RASTER_TOTAL = "60 seconds"
const PREVIEW_TOTAL = "120 seconds"

/** Metadata reads: the same bound as the catalog export. */
const METADATA_LIMIT = 32 * 1024 * 1024

/**
 * Sized well above the preview's upper bound — ~22MB at the script's MAX_SIDE of 2048 — because the two failures
 * are not symmetrical: an oversized ceiling allocates nothing, while an undersized one truncates the payload into
 * an unattributable "no marker" failure instead of a loud one (§4.13 校准量).
 */
const PREVIEW_LIMIT = 128 * 1024 * 1024

/**
 * Reading must not write: GDAL saves computed statistics as a `.aux.xml` beside the user's data when the dataset
 * closes, and opening read-only does not stop it (§7.6, §4.13). On the READER ONLY — an algorithm that writes a
 * raster may need PAM to persist a coordinate system its output format cannot hold.
 */
const NO_SIDECARS = { GDAL_PAM_ENABLED: "NO" } as const

export interface VectorOptions {
  readonly file: string
  /** Features to sample; the script defaults to 3. */
  readonly maxFeatures?: number
  /** 1-based feature start position; the script defaults to 1. */
  readonly offset?: number
  /** Layer to read in multi-layer sources; the script defaults to 0. */
  readonly layerIndex?: number
  readonly abort?: AbortSignal
}

export interface RasterOptions {
  readonly file: string
  readonly abort?: AbortSignal
}

export type MetadataOutcome =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string }

export interface PreviewMeta {
  readonly width?: number
  readonly height?: number
  readonly original_width?: number
  readonly original_height?: number
  readonly bands?: readonly number[]
  readonly bytes?: number
  /** The five georeferencing facts, in the shape `Georeference.reported` reads. */
  readonly georeferencing?: unknown
}

export type PreviewOutcome =
  | { readonly ok: true; readonly meta: PreviewMeta; readonly base64: string }
  | { readonly ok: false; readonly detail: string }

/**
 * Materialize a script constant as a file in the application cache, named by content hash: a changed script lands
 * under a new name, and a file already bearing the name is by construction the right content.
 */
export function materialize(
  name: string,
  content: string,
  directory: string = path.join(Global.Path.cache, "geo", "scripts"),
): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  const target = path.join(directory, `${name}-${hash}.py`)
  if (!existsSync(target)) {
    mkdirSync(directory, { recursive: true })
    // Write-then-rename, so a file under the target name is never a partial one a concurrent instance could spawn.
    const staging = path.join(directory, `${name}-${hash}.${process.pid}.tmp`)
    writeFileSync(staging, content, "utf8")
    try {
      renameSync(staging, target)
    } catch (error) {
      // Windows refuses a rename onto a path another process just created; the name is content-addressed, so a
      // target that exists now holds exactly these bytes.
      if (!existsSync(target)) throw error
    }
  }
  return target
}

/* Windows Python stdio can interleave U+FEFF anywhere in the stream, including inside the marker line. JSON.parse
 * rejects it as non-whitespace and trim() only reaches the edges, so every occurrence goes up-front. */
const stripBom = (text: string) => text.replace(/\uFEFF/g, "")

/** Read vector metadata, statistics and sampled features. */
export function readVector(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: VectorOptions,
): Effect.Effect<MetadataOutcome, Error> {
  const args = [options.file, String(options.maxFeatures ?? 3), String(options.offset ?? 1)]
  if (options.layerIndex !== undefined) args.push(String(options.layerIndex))
  return runRead(runtime, environment, {
    name: "vector_read",
    content: VECTOR_READ_PY,
    args,
    total: VECTOR_TOTAL,
    limit: METADATA_LIMIT,
    label: "qgis:read-vector",
    abort: options.abort,
  }).pipe(Effect.map(parseMetadata))
}

/** Read raster metadata and band statistics. */
export function readRaster(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: RasterOptions,
): Effect.Effect<MetadataOutcome, Error> {
  return runRead(runtime, environment, {
    name: "raster_read",
    content: RASTER_READ_PY,
    args: [options.file],
    total: RASTER_TOTAL,
    limit: METADATA_LIMIT,
    label: "qgis:read-raster",
    abort: options.abort,
  }).pipe(Effect.map(parseMetadata))
}

/** Render a raster preview: marker-tagged metadata line, then base64 PNG. */
export function renderPreview(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: RasterOptions,
): Effect.Effect<PreviewOutcome, Error> {
  return runRead(runtime, environment, {
    name: "raster_preview",
    content: RASTER_PREVIEW_PY,
    args: [options.file],
    total: PREVIEW_TOTAL,
    limit: PREVIEW_LIMIT,
    label: "qgis:read-preview",
    abort: options.abort,
  }).pipe(Effect.map(parsePreview))
}

interface ReadSpec {
  readonly name: string
  readonly content: string
  readonly args: readonly string[]
  readonly total: Duration.Input
  readonly limit: number
  readonly label: string
  readonly abort?: AbortSignal
}

function runRead(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  spec: ReadSpec,
): Effect.Effect<GeoRuntime.Result, Error> {
  // Effect.try, not Effect.sync: a read-only cache directory or a full disk must surface as the declared Error
  // rather than a defect.
  return Effect.try({
    try: () => materialize(spec.name, spec.content),
    catch: (error) =>
      new Error(
        `could not write the ${spec.name} script to the cache: ${error instanceof Error ? error.message : String(error)}`,
      ),
  }).pipe(
    Effect.flatMap((scriptPath) =>
      runtime.run({
        command: environment.python,
        // wrapScript preserves direct-execution semantics under the manual Windows track's DLL bootstrap, and is
        // the identity where there is nothing to register (§4.5).
        args: QgisBootstrap.wrapScript(scriptPath, spec.args, environment.dllDirectories),
        env: { ...environment.env, ...NO_SIDECARS },
        delivery: { mode: "collect", limit: spec.limit },
        clocks: { total: spec.total },
        abort: spec.abort,
        label: spec.label,
      }),
    ),
  )
}

/** Failure grading shared with the probe (§4.6): the ending leads, the raw tail follows. */
function failed(result: GeoRuntime.Result, why: string): { ok: false; detail: string } {
  const ending =
    result.reason !== "exit" || result.code !== 0
      ? `[process ${result.reason}${result.code !== null ? `, exit code ${result.code}` : ""}]\n`
      : ""
  return { ok: false, detail: `${why}\n${ending}${tail(result.stdout, result.stderr) || "(no output at all)"}` }
}

function parseMetadata(result: GeoRuntime.Result): MetadataOutcome {
  const extracted = GeoOutput.extractMarked(stripBom(result.stdout), MARKER)
  if (!extracted.ok) {
    return extracted.kind === "invalid"
      ? failed(result, `read result would not parse (${extracted.error})`)
      : failed(result, "the read script never reached its output marker")
  }
  const payload = extracted.value as Record<string, unknown>
  if (typeof payload.error === "string") return { ok: false, detail: payload.error }
  return { ok: true, payload }
}

function parsePreview(result: GeoRuntime.Result): PreviewOutcome {
  const stdout = stripBom(result.stdout)
  const lines = stdout.split("\n")
  // Last occurrence, same rule as extractMarked — and CONTAINS, not starts-with: unterminated C-level chatter can
  // end up glued to the front of the marker's own line.
  let markerLine = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(MARKER)) {
      markerLine = i
      break
    }
  }
  if (markerLine < 0) return failed(result, "the preview script never reached its output marker")

  let meta: unknown
  try {
    const line = lines[markerLine]!
    meta = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length))
  } catch (error) {
    return failed(
      result,
      `preview metadata would not parse (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (typeof meta !== "object" || meta === null) {
    return failed(result, "preview metadata is not an object")
  }
  const record = meta as Record<string, unknown>
  if (typeof record.error === "string") return { ok: false, detail: record.error }

  const base64 = lines
    .slice(markerLine + 1)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!base64) {
    // The classic undersized-cap signature: metadata arrived, image did not.
    return failed(result, "preview produced metadata but no image payload followed the marker line")
  }

  // The image gets the completeness check JSON.parse gave the metadata for free. The script writes the marker line
  // before the image, so a clock expiring — or the output cap tripping — mid-transfer leaves a valid marker line
  // above a half-written payload; base64 length follows exactly from the byte count the script reports.
  if (typeof record.bytes === "number") {
    const expected = 4 * Math.ceil(record.bytes / 3)
    if (base64.length !== expected) {
      return failed(
        result,
        `the preview image is incomplete (${base64.length} of ${expected} encoded characters for ${record.bytes} bytes)`,
      )
    }
  }
  return { ok: true, meta: record as PreviewMeta, base64 }
}

function tail(stdout: string, stderr: string): string {
  const joined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n")
  return GeoOutput.truncate(joined, 8_000).text
}
