import * as path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoQgis, GeoRuntime, GeoStatus } from "@/geo"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./geo-read.txt"

/* --- GeoCode: ReadGeoData, the geographic counterpart of `read`
 * (docs/TOOLS.md §3, GEOKERNEL §10.1 #9).
 *
 * Same skeleton as read on purpose: resolve the path, stat tolerantly, gate
 * external directories, ask BEFORE revealing whether the file exists, offer
 * nearby candidates on a miss, hand images to the model as attachments. What
 * read cannot do — and why this tool exists — is open the binary geo formats:
 * its binary guard rejects exactly the files this tool is for, and its text
 * path would silently truncate a large GeoJSON at 50 KB and call it data.
 *
 * The QGIS work itself lives in the geo kernel (reader.ts): scripts, JSON
 * markers, BOM, timeouts. This layer holds only what a *tool* owes the
 * session: permission, the readiness gate, the environment header, and the
 * shaping of outcomes. --- */

/**
 * The formats vector_read.py / raster_read.py were built and validated
 * against — a subset of the shared taxonomy's *_MAIN lists (tripwired as
 * such): advertising the whole taxonomy would claim formats the reader
 * scripts have never seen.
 */
export const VECTOR_SUPPORTED = ["shp", "geojson", "gpkg", "gml", "kml", "gpx", "fgb"]
export const RASTER_SUPPORTED = ["tif", "tiff", "img", "asc", "dem"]

const FEATURE_DEFAULT = 3
const FEATURE_CAP = 50

/**
 * The model-facing size budget for one read, in BYTES of the exact string the
 * model receives (compact JSON — the fit and the output must share one
 * serialization, or the budget is fiction; and bytes, not code units, or CJK
 * attribute values count one for three). Overflow here has exactly one
 * realistic cause — sampled features with fat attributes or geometry — so the
 * remedy is to DROP FEATURES, never to cut the string: a head-cut JSON is
 * syntactically dead, while a shorter feature list is still the same honest
 * shape with a smaller sample (docs/TOOLS.md §5).
 */
const OUTPUT_BUDGET = 50 * 1024

const measure = (payload: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(payload), "utf-8")

/**
 * Trim `payload.layer.features` from the tail until the serialized payload
 * fits the budget. Returns how many were dropped and whether it fits now —
 * `fits: false` means even the featureless payload is over budget (a very
 * wide schema's field statistics), which we ship honestly rather than cut.
 * Exported for the tripwire: this is pure shaping, testable without QGIS.
 */
export function fitVectorPayload(
  payload: Record<string, unknown>,
  budget: number,
): { dropped: number; fits: boolean } {
  const layer = payload.layer as Record<string, unknown> | undefined
  const features = layer?.features
  let dropped = 0
  if (measure(payload) <= budget) return { dropped, fits: true }
  if (Array.isArray(features)) {
    while (features.length > 0 && measure(payload) > budget) {
      features.pop()
      dropped += 1
    }
  }
  return { dropped, fits: measure(payload) <= budget }
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the geographic data file" }),
  mode: Schema.Literals(["metadata", "preview"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("metadata" as const)))
    .annotate({
      description:
        '"metadata" (default): structured metadata, statistics and sampled features. "preview": a rendered PNG image of the raster (raster formats only).',
    }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "1-based position of the first vector feature to return (vector metadata only, defaults to 1)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: `Maximum number of vector features to return (vector metadata only, defaults to ${FEATURE_DEFAULT}, capped at ${FEATURE_CAP})`,
  }),
  layerIndex: Schema.optional(NonNegativeInt).annotate({
    description: "Index of the layer to read (GeoPackage only, defaults to 0)",
  }),
})

type Metadata = {
  [key: string]: unknown
  /** Always set: output is bounded by the kernel's read caps, so the generic
   * head-truncation must never run — it would cut the tail, where everything
   * a failed read needs for attribution lives (docs/TOOLS.md §5). */
  truncated: boolean
}

export const GeoReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | GeoQgis.Service | GeoRuntime.Service | GeoStatus.Service
>(
  "ReadGeoData",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const qgis = yield* GeoQgis.Service
    const runtime = yield* GeoRuntime.Service
    const status = yield* GeoStatus.Service

    // Same shape as read's miss(): a not-found error that names up to three
    // similarly-named neighbours instead of leaving the model to guess.
    const miss = Effect.fn("GeoReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((entries) =>
          entries
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )
      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }
      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const run = Effect.fn("GeoReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      // Ask before revealing anything about the file — including whether it
      // exists (read's ordering, kept for the same information-leak reason).
      yield* ctx.ask({
        permission: "geo_qgis_read",
        patterns: [title],
        always: ["*"],
        metadata: { file: title, mode: params.mode },
      })

      if (!stat) return yield* miss(filepath)
      if (stat.type === "Directory") {
        return yield* Effect.fail(new Error(`ReadGeoData reads files, but this is a directory: ${filepath}`))
      }

      const ext = path.extname(filepath).toLowerCase().slice(1)
      const isVector = VECTOR_SUPPORTED.includes(ext)
      const isRaster = RASTER_SUPPORTED.includes(ext)
      if (!isVector && !isRaster) {
        return yield* Effect.fail(
          new Error(
            `Unsupported format ".${ext}". Vector: ${VECTOR_SUPPORTED.map((item) => `.${item}`).join(", ")}. Raster: ${RASTER_SUPPORTED.map((item) => `.${item}`).join(", ")}. For plain text formats use the read tool.`,
          ),
        )
      }
      if (params.mode === "preview" && !isRaster) {
        return yield* Effect.fail(new Error("Preview mode is only supported for raster formats."))
      }

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        // Environment-not-ready is a diagnostic outcome for the model to relay,
        // not a defect (CONVENTIONS §6): the error bit and the status name ride
        // in metadata; the guidance rides in the output and is authored by the
        // kernel, one voice for the whole QGIS group (GEOKERNEL §8.6).
        // The empty-string fallback covers one sub-millisecond shape: a whole
        // probe round completing between the gate's two reads can hand back a
        // fully-ready status with ok:false, for which render has nothing.
        return {
          title,
          output:
            GeoQgis.QgisGuidance.render(gate.status) ||
            "The QGIS environment settled while this call was checking it — call the tool again.",
          metadata: { mode: params.mode, truncated: false, error: true, geoStatus: gate.status.status },
        }
      }
      const header = yield* GeoTool.qgisHeader(status)

      if (params.mode === "preview") {
        const outcome = yield* GeoQgis.QgisReader.renderPreview(runtime, gate.environment, {
          file: filepath,
          abort: ctx.abort,
        }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })))
        if (!outcome.ok) {
          return {
            title,
            output: [header, `Preview failed: ${outcome.detail}`].filter(Boolean).join("\n"),
            metadata: { mode: params.mode, truncated: false, error: true },
          }
        }
        const meta = outcome.meta
        const size =
          meta.original_width !== undefined && meta.original_height !== undefined
            ? `${meta.original_width}×${meta.original_height}${meta.width !== undefined ? ` → ${meta.width}×${meta.height}` : ""}`
            : undefined
        const summary = [
          "Raster preview rendered",
          size,
          meta.bands ? `bands ${meta.bands.join("-")}` : undefined,
          meta.bytes !== undefined ? `${(meta.bytes / 1024).toFixed(1)} KB` : undefined,
        ]
          .filter(Boolean)
          .join(", ")
        return {
          title,
          output: [header, summary].filter(Boolean).join("\n"),
          metadata: { ...meta, mode: params.mode, truncated: false },
          attachments: [
            {
              type: "file" as const,
              mime: "image/png",
              url: `data:image/png;base64,${outcome.base64}`,
            },
          ],
        }
      }

      const offset = Math.max(1, params.offset ?? 1)
      const requested = Math.min(Math.max(1, params.limit ?? FEATURE_DEFAULT), FEATURE_CAP)
      const outcome = yield* (isRaster
        ? GeoQgis.QgisReader.readRaster(runtime, gate.environment, { file: filepath, abort: ctx.abort })
        : GeoQgis.QgisReader.readVector(runtime, gate.environment, {
            file: filepath,
            offset,
            maxFeatures: requested,
            ...(ext === "gpkg" && params.layerIndex !== undefined ? { layerIndex: params.layerIndex } : {}),
            abort: ctx.abort,
          })
      ).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })))

      if (!outcome.ok) {
        return {
          title,
          output: [header, `Read failed: ${outcome.detail}`].filter(Boolean).join("\n"),
          metadata: { mode: params.mode, truncated: false, error: true },
        }
      }

      const payload = outcome.payload
      // The vector payload nests the layer detail under `layer` ({ driver,
      // layer_index, overview?, layer }); raster facts sit at the top level.
      // The layer object is where feature_count and the CRS facts live.
      const detail = (payload.layer ?? payload) as Record<string, unknown>
      const metadata: Metadata = { mode: params.mode, truncated: false, data_type: isRaster ? "raster" : "vector" }
      if (payload.driver !== undefined) metadata.driver = payload.driver
      if (detail.crs_name !== undefined) metadata.crs = detail.crs_name
      if (detail.feature_count !== undefined) metadata.feature_count = detail.feature_count
      if (detail.size !== undefined) metadata.size = detail.size
      if (detail.band_count !== undefined) metadata.band_count = detail.band_count
      // Defect warnings ride at metadata top level so the Agent sees them
      // without parsing the payload (kept from the old tool: missing CRS and
      // identity-geotransform are the two classic silent data defects).
      if (detail.crs_warning) metadata.crs_warning = detail.crs_warning
      if (detail.geotransform_warning) metadata.geotransform_warning = detail.geotransform_warning

      // Size is OUR gate, never upstream's (docs/TOOLS.md §5): over budget we
      // drop sampled features and say so — `truncated: true` here carries
      // read's meaning, "more exists, continue with offset", not "text was cut".
      // The payload ships COMPACT: the budget measures the very string sent,
      // and pretty-printing coordinate arrays would spend 3× the context on
      // whitespace.
      const fit = fitVectorPayload(payload, OUTPUT_BUDGET)
      let notice: string | undefined
      if (fit.dropped > 0) {
        const kept = Array.isArray(detail.features) ? detail.features.length : 0
        metadata.truncated = true
        metadata.dropped_features = fit.dropped
        notice = kept > 0
          ? `(Size cap: showing ${kept} of the ${requested} requested features. Continue with offset=${offset + kept}, or reduce limit.)`
          : `(Size cap: the sampled features are too large to inline even one. Retry with limit=1, or extract the attributes you need with a processing algorithm instead.)`
      } else if (!fit.fits) {
        notice = `(Size note: this layer's schema and statistics alone exceed the usual output budget; shipped whole.)`
      }

      return {
        title,
        output: [header, JSON.stringify(payload), notice].filter(Boolean).join("\n"),
        metadata,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
