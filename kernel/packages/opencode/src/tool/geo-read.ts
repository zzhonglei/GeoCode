import * as path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoQgis, GeoRuntime, GeoStatus } from "@/geo"
import { Georeference } from "@/geo/georeference"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { geoKind, RASTER_SUPPORTED, VECTOR_SUPPORTED } from "./geo-handoff"
import DESCRIPTION from "./geo-read.txt"

/* --- GeoCode: ReadGeoData, which keeps `read`'s order: resolve, stat, guard the boundary, ask before revealing
 * whether the file exists, then offer neighbours on a miss (docs/TOOLS.md §3). --- */

export { RASTER_SUPPORTED, VECTOR_SUPPORTED } from "./geo-handoff"

const FEATURE_DEFAULT = 3
const FEATURE_CAP = 50

/** UTF-8 bytes of the same JSON the output carries; code units would count a CJK value one for three. */
const OUTPUT_BUDGET = 50 * 1024

const measure = (payload: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(payload), "utf-8")

/** Drops features from the tail until the payload fits; `fits: false` means over even with none, shipped whole. */
export function fitVectorPayload(payload: Record<string, unknown>, budget: number): { dropped: number; fits: boolean } {
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
    description: "Index of the layer to read (multi-layer sources such as GeoPackage or GPX, defaults to 0)",
  }),
})

type Metadata = {
  [key: string]: unknown
  /** Always set, so `Tool.define` skips its head truncation, which would cut the notice and banner off the tail. */
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

      // Before the boundary guard too: that guard is the only prompt a user meets here, since `geodata` is allowed.
      const deadEnd = yield* GeoTool.qgisLocalDeadEnd(status)
      if (deadEnd) {
        return {
          title,
          output: GeoQgis.QgisGuidance.render(deadEnd),
          metadata: { truncated: false, error: true, geoStatus: GeoTool.gateStatus(deadEnd) },
        }
      }

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      // Ask before revealing anything about the file, including whether it exists.
      yield* ctx.ask({
        permission: "geodata",
        patterns: [title],
        always: ["*"],
        metadata: { file: title, mode: params.mode },
      })

      if (!stat) return yield* miss(filepath)
      if (stat.type === "Directory") {
        return yield* Effect.fail(new Error(`ReadGeoData reads files, but this is a directory: ${filepath}`))
      }

      const ext = path.extname(filepath).toLowerCase().slice(1)
      const kind = geoKind(filepath)
      if (!kind) {
        return yield* Effect.fail(
          new Error(
            `Unsupported format ".${ext}". Vector: ${VECTOR_SUPPORTED.map((item) => `.${item}`).join(", ")}. Raster: ${RASTER_SUPPORTED.map((item) => `.${item}`).join(", ")}. For plain text formats use the read tool.`,
          ),
        )
      }
      const isRaster = kind === "raster"
      if (params.mode === "preview" && !isRaster) {
        return yield* Effect.fail(new Error("Preview mode is only supported for raster formats."))
      }

      // Taken before the gate for a refusal, and again after it, since the gate can wait out a new round.
      const entryHeader = yield* GeoTool.qgisHeader(status)

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        // `render` returns "" for a fully ready status, which the gate can still refuse when a round lands mid-check.
        return {
          title,
          output: [
            entryHeader,
            GeoQgis.QgisGuidance.render(gate.status) ||
              "The QGIS environment settled while this call was checking it — call the tool again.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          metadata: {
            mode: params.mode,
            truncated: false,
            error: true,
            geoStatus: GeoTool.gateStatus(gate.status),
          },
        }
      }
      const header = yield* GeoTool.qgisHeader(status)

      // The only termination rendered here, since the reader folds the others into `detail`.
      const cancelled = () => ({
        title,
        output: [header, GeoTool.terminationBanner("abort")].filter(Boolean).join("\n"),
        metadata: {
          mode: params.mode,
          truncated: false,
          error_code: "Aborted",
          aborted: true,
          partial: true,
        },
      })

      // Lists the five absent facts, because "not geographic data" alone reads as a guess and invites a retry.
      const notGeographic = () => ({
        title,
        output: [
          header,
          "This file has no georeferencing — no transform, control points, RPC coefficients, " +
            "geolocation arrays or coordinate system. It is an image, not geographic data.",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {
          mode: params.mode,
          truncated: false,
          data_type: "raster",
          georeference: "none",
          error_code: "NotGeographic",
          failed: true,
        },
      })

      if (params.mode === "preview") {
        const outcome = yield* GeoQgis.QgisReader.renderPreview(runtime, gate.environment, {
          file: filepath,
          abort: ctx.abort,
        }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })))
        if (!outcome.ok) {
          if (ctx.abort.aborted) return cancelled()
          return {
            title,
            output: [header, `Preview failed: ${outcome.detail}`].filter(Boolean).join("\n"),
            // Not `error: true`, which marks a shut gate and travels with `geoStatus`.
            metadata: { mode: params.mode, truncated: false, error_code: "PreviewFailed", failed: true },
          }
        }
        const meta = outcome.meta
        if (Georeference.of(Georeference.reported(meta.georeferencing)) === "none") return notGeographic()
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
      const outcome = yield* (
        isRaster
          ? GeoQgis.QgisReader.readRaster(runtime, gate.environment, { file: filepath, abort: ctx.abort })
          : GeoQgis.QgisReader.readVector(runtime, gate.environment, {
              file: filepath,
              offset,
              maxFeatures: requested,
              // For any driver: vector_read.py lists layers for every multi-layer source, not only GeoPackage.
              ...(params.layerIndex !== undefined ? { layerIndex: params.layerIndex } : {}),
              abort: ctx.abort,
            })
      ).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })))

      if (!outcome.ok) {
        if (ctx.abort.aborted) return cancelled()
        return {
          title,
          output: [header, `Read failed: ${outcome.detail}`].filter(Boolean).join("\n"),
          metadata: { mode: params.mode, truncated: false, error_code: "ReadFailed", failed: true },
        }
      }

      const payload = outcome.payload
      if (payload.georeferencing !== undefined) {
        // The verdict replaces the raw facts, so the Agent gets the conclusion rather than five fields to combine.
        const verdict = Georeference.of(Georeference.reported(payload.georeferencing))
        if (verdict === "none") return notGeographic()
        payload.georeferencing = verdict
      }
      // vector_read.py nests the layer facts under `layer`; raster_read.py reports them at the top.
      const detail = (payload.layer ?? payload) as Record<string, unknown>
      const metadata: Metadata = { mode: params.mode, truncated: false, data_type: isRaster ? "raster" : "vector" }
      if (payload.driver !== undefined) metadata.driver = payload.driver
      if (detail.crs_name !== undefined) metadata.crs = detail.crs_name
      if (detail.feature_count !== undefined) metadata.feature_count = detail.feature_count
      if (detail.size !== undefined) metadata.size = detail.size
      if (detail.band_count !== undefined) metadata.band_count = detail.band_count
      if (payload.georeferencing !== undefined) metadata.georeference = payload.georeferencing
      if (detail.crs_warning) metadata.crs_warning = detail.crs_warning
      if (detail.geotransform_warning) metadata.geotransform_warning = detail.geotransform_warning

      // `truncated: true` means more features exist, as in `read`, hence no `outputPath` (docs/TOOLS.md §5.2).
      // A layer reporting `geometry_types` is sampled per type and ignores offset, so its notice offers none.
      const paged = detail.geometry_types === undefined
      const fit = fitVectorPayload(payload, OUTPUT_BUDGET)
      let notice: string | undefined
      if (fit.dropped > 0) {
        const kept = Array.isArray(detail.features) ? detail.features.length : 0
        metadata.truncated = true
        metadata.dropped_features = fit.dropped
        const continueWith = paged
          ? `Continue with offset=${offset + kept}, or reduce limit.`
          : `This layer mixes geometry types, so its sample is drawn per type rather than in order — reduce limit, or split the layer by geometry type first.`
        notice =
          kept > 0
            ? `(Size cap: showing ${kept} of the ${requested} requested features. ${continueWith})`
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
