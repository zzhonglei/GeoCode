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
 * Same shape as the executor: pure functions over a VERIFIED environment the
 * gate handed out (§4.9, §9.1), stateless between calls. The scripts travel as
 * generated constants and run MATERIALIZED — the vector script alone consumes
 * about three quarters of the Windows command-line length limit when passed
 * inline, so inline transport has no safety margin left (§4.13 校准量). --- */

/** One marker for the whole family; each script embeds the same string. */
export const MARKER = "__GEOCODE_READ_JSON__"

/**
 * Wall-clock bounds, carried over from the calibrated production values.
 * Total clocks, not idle: a full-table statistics scan is legitimately silent
 * for its whole runtime, so an idle clock would misread the workload (§8.4 —
 * these are the kernel-known tier).
 */
const VECTOR_TOTAL = "120 seconds" // GeoJSON/GML drivers parse the whole file at open — GDAL-side cost no scan avoids
const RASTER_TOTAL = "60 seconds"
const PREVIEW_TOTAL = "120 seconds"

/** Metadata reads: same generous bound as the catalog export, same rationale. */
const METADATA_LIMIT = 32 * 1024 * 1024

/**
 * The preview cap is sized to the preview's UPPER BOUND, explicitly: at
 * MAX_SIDE 4096 the raw RGBA plane is 64MB, a pathological PNG stays near
 * raw size, and base64 adds a third — ~90MB worst case. An undersized cap
 * here does not fail loudly: it truncates the payload and masquerades as an
 * unattributable "no marker" failure (§4.13 校准量).
 */
const PREVIEW_LIMIT = 128 * 1024 * 1024

export interface VectorOptions {
  readonly file: string
  /** Features to sample. The caller owns range policy; the script defaults to 3. */
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
}

export type PreviewOutcome =
  | { readonly ok: true; readonly meta: PreviewMeta; readonly base64: string }
  | { readonly ok: false; readonly detail: string }

/**
 * Materialize a script constant as a file in the application cache.
 *
 * Content-hash naming makes refresh automatic: a script change lands under a
 * new name, and an existing file with the right name is by construction the
 * right content — no versioning, no cleanup protocol (stale generations are a
 * few kilobytes). Returns the absolute path.
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
    // Write-then-rename: an existing file must never be a partial one, or a
    // concurrent instance could spawn Python on half a script. Same-content
    // overwrite from a lost race is harmless by construction.
    const staging = path.join(directory, `${name}-${hash}.${process.pid}.tmp`)
    writeFileSync(staging, content, "utf8")
    renameSync(staging, target)
  }
  return target
}

/* Windows Python stdio can interleave U+FEFF (UTF-8 BOM) when the console
 * codepage flips to UTF-8 mid-stream — and these are exactly the scripts that
 * trigger the flip, because they print non-ASCII attribute values. JSON.parse
 * rejects BOM as non-whitespace per RFC 8259 and String.trim() only handles
 * edges, so every U+FEFF is stripped up-front. No-op on macOS. */
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
  return Effect.sync(() => materialize(spec.name, spec.content)).pipe(
    Effect.flatMap((scriptPath) =>
      runtime.run({
        command: environment.python,
        // wrapScript preserves direct-execution semantics under the manual
        // Windows track's DLL bootstrap, and is the identity elsewhere (§4.5).
        args: QgisBootstrap.wrapScript(scriptPath, spec.args, environment.dllDirectories),
        env: environment.env,
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
  // Last occurrence, same rule as extractMarked — and CONTAINS, not
  // starts-with: unterminated C-level chatter (a GDAL warning without its
  // newline) can end up glued to the front of the marker's own line.
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
  return { ok: true, meta: record as PreviewMeta, base64 }
}

function tail(stdout: string, stderr: string): string {
  const joined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n")
  return GeoOutput.truncate(joined, 8_000).text
}
