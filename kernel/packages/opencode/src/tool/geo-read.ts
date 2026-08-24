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

/* --- GeoCode: ReadGeoData, the geographic counterpart of `read` (docs/TOOLS.md §3, GEOKERNEL §10.1 #9).
 *
 * Same skeleton as read on purpose: resolve the path, stat tolerantly, guard external directories, ask BEFORE
 * revealing whether the file exists, offer nearby candidates on a miss. The QGIS half — scripts, JSON markers,
 * BOM, timeouts — is the kernel's (qgis/reader.ts); what lives here is what a *tool* owes the session:
 * permission, the readiness gate, the environment header and the shaping of outcomes. --- */

/* One array for both sides of the handoff, so what `read` redirects and what this tool accepts cannot disagree
 * (docs/TOOLS.md §7). */
export { RASTER_SUPPORTED, VECTOR_SUPPORTED } from "./geo-handoff"

const FEATURE_DEFAULT = 3
const FEATURE_CAP = 50

/**
 * Bytes of the exact compact JSON the model receives (docs/TOOLS.md §5.2). Measuring anything else makes the
 * budget fiction: the fit and the output must share one serialization, and code units would count a CJK attribute
 * value one for three. Overflow drops sampled features rather than cutting the string, which would be dead JSON.
 */
const OUTPUT_BUDGET = 50 * 1024

const measure = (payload: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(payload), "utf-8")

/**
 * Drops `payload.layer.features` from the tail until the payload fits. `fits: false` means even the featureless
 * payload is over budget — a very wide schema's field statistics — which ships whole rather than cut. Exported
 * because it is pure shaping, so the tripwire can exercise it without QGIS.
 */
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
  /** Never left unset: `Tool.define` skips its own truncation once this field exists, and that truncation keeps
   * the head and drops the tail, where the notice and the banner are (docs/TOOLS.md §5.1). */
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

    // read's miss(), same shape: a not-found error naming up to three similarly-named neighbours.
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

      // Above the boundary guard, not merely above `ctx.ask`: the guard is a prompt too, and the only one a user
      // meets here, since `geodata` is granted outright while `external_directory` is not (docs/TOOLS.md §3).
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

      // Ask before revealing anything about the file, including whether it exists — read's ordering, kept.
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

      // Snapshotted before the gate so a refusal still carries the environment line, and taken again after it
      // (§11 环境头快照).
      const entryHeader = yield* GeoTool.qgisHeader(status)

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        // The fallback covers the one shape the gate refuses without a complaint to render: a new round that has
        // completed between the gate's two status reads leaves it returning `ok: false` beside a
        // fully-ready one, and `QgisGuidance.render` answers those with "".
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

      /** The only one of the five terminations this tool renders: the reader collapses every other ending into a
       * `detail` string, so the rest become `error_code` (GEOKERNEL §11). Cancelling is not failing — upstream
       * completes the call with whatever a cancelled tool returned (session/tools.ts). */
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

      /** Both modes reach this through `Georeference.of`, so one file cannot get two accounts (GEOKERNEL §7.9).
       * The five places are named rather than summarized: "not geographic data" alone reads like a guess about
       * the file and invites a second attempt at it. */
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
            // `error: true` is reserved for the shut gate, where it travels with `geoStatus`; reusing it for a
            // data failure would have a failed render show up as an environment card.
            metadata: { mode: params.mode, truncated: false, error_code: "PreviewFailed", failed: true },
          }
        }
        const meta = outcome.meta
        // Judged after the render because the facts arrive with it; the wasted encode falls only on the files
        // being refused, which are ordinary pictures.
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
              // Passed through for any driver, not just GeoPackage: vector_read.py emits the overview whenever
              // layer_count > 1, so gating selection on `.gpkg` would list a .gpx's layers with no way past the
              // first.
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
        // The reported block is replaced by its verdict rather than shipped beside it: the Agent is owed the
        // conclusion, not five raw fields it would have to combine itself.
        const verdict = Georeference.of(Georeference.reported(payload.georeferencing))
        if (verdict === "none") return notGeographic()
        payload.georeferencing = verdict
      }
      // vector_read.py nests the layer facts under `layer`, keeping only driver, layer_index and overview at the
      // top; raster_read.py puts everything at the top. `feature_count` and the CRS facts are on the inner one.
      const detail = (payload.layer ?? payload) as Record<string, unknown>
      const metadata: Metadata = { mode: params.mode, truncated: false, data_type: isRaster ? "raster" : "vector" }
      if (payload.driver !== undefined) metadata.driver = payload.driver
      if (detail.crs_name !== undefined) metadata.crs = detail.crs_name
      if (detail.feature_count !== undefined) metadata.feature_count = detail.feature_count
      if (detail.size !== undefined) metadata.size = detail.size
      if (detail.band_count !== undefined) metadata.band_count = detail.band_count
      if (payload.georeferencing !== undefined) metadata.georeference = payload.georeferencing
      // Lifted to the metadata's top level so a reader sees them without parsing the payload: a missing CRS and
      // an identity geotransform are the two data defects that are otherwise silent.
      if (detail.crs_warning) metadata.crs_warning = detail.crs_warning
      if (detail.geotransform_warning) metadata.geotransform_warning = detail.geotransform_warning

      // `truncated: true` here carries read's meaning — more exists, continue with offset — not "text was cut",
      // so it arrives without an `outputPath` (docs/TOOLS.md §5.2).
      //
      // Except on a mixed layer: vector_read.py samples those by geometry type across the whole layer and ignores
      // offset entirely, and `geometry_types` on the payload is how it says so. Continuing with offset there
      // would ask for the features the caller already has.
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
