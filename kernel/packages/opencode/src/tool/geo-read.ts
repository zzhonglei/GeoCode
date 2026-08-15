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

/* The advertised formats live next to the `read` handoff that redirects them
 * here, so the two cannot disagree about what this tool accepts — the old
 * build kept a second hand-copied list in read.ts and had nothing but memory
 * holding them together. */
export { RASTER_SUPPORTED, VECTOR_SUPPORTED } from "./geo-handoff"

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
      // The same judgement `read` redirects on (geo-handoff.ts). One function,
      // both sides: what this tool accepts and what that tool hands over cannot
      // disagree, because there is nothing to keep in agreement.
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

      // Snapshotted before the gate so a refusal still carries the environment
      // line, and taken again after it (§11.2 环境头快照). Without the entry
      // snapshot this tool answered a shut gate bare while RunQgisAlgorithm
      // answered the same event with a header — one event, two shapes.
      const entryHeader = yield* GeoTool.qgisHeader(status)

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

      /**
       * A cancelled read is not a failed read.
       *
       * Upstream does not interrupt a tool when the signal fires — it takes
       * whatever the tool returns and completes the call with it
       * (session/tools.ts) — so grading a cancellation as a failure files the
       * user's own Esc under "the read broke", and the Agent reads that as
       * something to retry. Same banner the QGIS group's other tools use, so
       * one event does not arrive as two different stories.
       */
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

      /**
       * A raster with no georeferencing is not this tool's to open.
       *
       * The five places are named rather than summarized. "Not geographic data"
       * on its own reads like a guess about the file and invites a second
       * attempt at it; a list of what was looked for and not found does not.
       *
       * Both modes reach it from the same five facts through the same
       * function, so they cannot come back with two accounts of one file
       * (GEOKERNEL §7.9).
       */
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
            // A data failure, not an environment one. `error: true` is reserved
            // for the shut gate, where it travels with geoStatus; reusing it
            // here would have a failed render render as an environment card.
            metadata: { mode: params.mode, truncated: false, error_code: "PreviewFailed", failed: true },
          }
        }
        const meta = outcome.meta
        // After the render rather than before it, because the facts arrive with
        // it. The wasted encode falls exactly on the files being refused, and
        // those are pictures — the scenes worth minutes all pass.
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
              // Any multi-layer driver, not just GeoPackage: the reader emits an
              // overview whenever layer_count > 1, so gating selection on .gpkg
              // showed a .gpx's five layers and gave no way to reach past the first.
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

      /* A container is not a scene and is not an image either (§7.9).
       *
       * netCDF, HDF and GRIB files holding several variables — MODIS, Sentinel,
       * ERA5 — open with no bands, a placeholder size and none of the five
       * georeferencing facts, because those belong to the variables inside. The
       * verdict on that evidence is correctly `none`, and `none` means "an
       * ordinary image" — so without this branch an ERA5 scene is answered with
       * "It is an image, not geographic data" and the payload naming its
       * variables is thrown away with it.
       *
       * Read off the payload rather than from a second guess at the band count:
       * the script already decided, and one decision is better than two that
       * can disagree. */
      const payload = outcome.payload
      const container = Array.isArray(payload.subdatasets) && payload.subdatasets.length > 0
      if (payload.georeferencing !== undefined) {
        if (container) {
          // Not judged at all, rather than judged and set aside: the five facts
          // here describe the placeholder, so any verdict drawn from them would
          // be a statement about the box wearing the name of the file.
          // `container_warning` and the subdataset list say what it really is.
          delete payload.georeferencing
        } else {
          // The same judgement the preview path makes, from the same five facts.
          // The block is then REPLACED by its verdict: the Agent is owed the
          // conclusion — `rpc` says an extent it is about to read is still pixel
          // indices — and not five raw fields it would have to combine itself.
          const verdict = Georeference.of(Georeference.reported(payload.georeferencing))
          if (verdict === "none") return notGeographic()
          payload.georeferencing = verdict
        }
      }
      // The vector payload nests the layer detail under `layer` ({ driver,
      // layer_index, overview?, layer }); raster facts sit at the top level.
      // The layer object is where feature_count and the CRS facts live.
      const detail = (payload.layer ?? payload) as Record<string, unknown>
      const metadata: Metadata = { mode: params.mode, truncated: false, data_type: isRaster ? "raster" : "vector" }
      if (payload.driver !== undefined) metadata.driver = payload.driver
      if (detail.crs_name !== undefined) metadata.crs = detail.crs_name
      if (detail.feature_count !== undefined) metadata.feature_count = detail.feature_count
      // A container's size is GDAL's placeholder, so it is withheld rather than
      // published: the double-channel contract (§9.1) means an interface reads
      // this and never the prose, and 512×512 in a field named `size` is a
      // fiction no warning alongside it can undo.
      if (detail.size !== undefined && !container) metadata.size = detail.size
      if (detail.band_count !== undefined) metadata.band_count = detail.band_count
      if (payload.georeferencing !== undefined) metadata.georeference = payload.georeferencing
      // What the file actually offers, for an interface that has to show it
      // without parsing prose. The count, not the list — the names are long and
      // the payload already carries them in full.
      if (container) metadata.subdatasets = (payload.subdatasets as unknown[]).length
      // Defect warnings ride at metadata top level so the Agent sees them
      // without parsing the payload (kept from the old tool: missing CRS and
      // identity-geotransform are the two classic silent data defects).
      if (detail.crs_warning) metadata.crs_warning = detail.crs_warning
      if (detail.geotransform_warning) metadata.geotransform_warning = detail.geotransform_warning
      if (detail.container_warning) metadata.container_warning = detail.container_warning

      // Size is OUR gate, never upstream's (docs/TOOLS.md §5): over budget we
      // drop sampled features and say so — `truncated: true` here carries
      // read's meaning, "more exists, continue with offset", not "text was cut".
      // The payload ships COMPACT: the budget measures the very string sent,
      // and pretty-printing coordinate arrays would spend 3× the context on
      // whitespace.
      // A layer holding more than one geometry type is sampled BY TYPE, across
      // the whole layer, and ignores offset entirely (vector_read.py's mixed
      // branch) — `geometry_types` on the payload is how it says so. Telling
      // the caller to continue with offset there would send it back for the
      // same features it already has.
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
