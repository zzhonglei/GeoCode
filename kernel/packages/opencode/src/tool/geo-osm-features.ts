import * as path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-features.txt"

/* --- GeoCode: OsmGetFeatures, the bulk download (docs/TOOLS.md §3). A file of the wrong features looks like one of
 * the right ones, so the widening caveat and the centroid count are data contracts (GEOKERNEL §6.4, §6.8). --- */

export const Parameters = Schema.Struct({
  extents: Schema.Array(Schema.String).annotate({
    description:
      'One or more extents: "area:R<id>" (relations only), "bbox:S,W,N,E", "around:radius_m,lat,lon", "file:/abs/path.geojson" (EPSG:4326). At most 12 per call; results are merged and cross-extent duplicates removed.',
  }),
  tags: Schema.Array(Schema.String).annotate({
    description:
      'A tag union, e.g. ["amenity=hospital", "amenity=clinic", "healthcare"]. Formats: "key=value", "key" (presence), "key~regex".',
  }),
  output: Schema.String.annotate({
    description:
      "Absolute path for the result. A path not ending in .geojson gets it appended, and the report names the file(s) actually written.",
  }),
  types: Schema.optional(Schema.String).annotate({
    description:
      'Element types: "nwr" (default, all), or a comma list. "way,relation" gives area features only. For a POI dataset do NOT use "node" — area-mapped facilities would be dropped; keep "nwr" and use geometry "centroid".',
  }),
  geometry: Schema.optional(Schema.Literals(["original", "centroid"])).annotate({
    description:
      '"original" (default) keeps geometry as mapped. "centroid" collapses every feature to one representative point, recording its original type in an "original_geometry" column.',
  }),
  fields: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Extra tag keys to keep as columns. By default the core identity columns plus the queried tag keys survive; other tags are dropped and reported by key. Pass ["*"] to keep all tags losslessly in an "osm_tags" column.',
  }),
  timeout: Schema.optional(Schema.Int).annotate({
    description:
      "Seconds the server may spend on each extent (default 120; anything lower is raised to 30). Raising it is the fix for an extent that comes back marked incomplete.",
  }),
})

/**
 * Setting `truncated` skips upstream's truncation, and false holds because the features go to disk (docs/TOOLS.md
 * §5.2). Failures use `error_code`, never `error: true`, which means an environment is not ready.
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const OsmGetFeaturesTool = Tool.define<typeof Parameters, Metadata, GeoOsm.Service>(
  "OsmGetFeatures",
  Effect.gen(function* () {
    const osm = yield* GeoOsm.Service

    const run = Effect.fn("OsmGetFeaturesTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      // Resolved here: the kernel would resolve a relative path against the process cwd, not the instance directory.
      const instance = yield* InstanceState.context
      let filepath = params.output
      if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
      if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)
      const title = path.relative(instance.worktree, filepath)

      const refuse = (message: string) => ({
        title,
        output: message,
        metadata: { truncated: false, error_code: "InvalidParameters", failed: true } as Metadata,
      })

      // Refused here: the kernel would return zero features, which reads as an area holding none of this category.
      if (params.extents.length === 0) {
        return refuse('"extents" is empty — name at least one area to download from.')
      }
      if (params.tags.length === 0) {
        return refuse('"tags" is empty — name at least one tag filter, e.g. ["amenity=hospital"].')
      }

      // Asked before the call, which writes files and can read a boundary file; the pattern is worktree-relative.
      yield* ctx.ask({
        permission: "osm",
        patterns: [title],
        always: ["*"],
        metadata: { extents: params.extents, tags: params.tags, output: filepath },
      })

      // The boundary guard after the capability, so an agent denied `osm` is never asked about a directory.
      yield* assertExternalDirectoryEffect(ctx, filepath)

      const outcome = yield* Effect.result(
        osm.downloadFeatures({
          extents: params.extents,
          tags: params.tags,
          output: filepath,
          types: params.types,
          fields: params.fields,
          geometry: params.geometry,
          timeoutSec: params.timeout,
          abort: ctx.abort,
          // `extents_settled` counts failures too; `extents_done` does not.
          onProgress: (settled, total) =>
            ctx.metadata({
              title,
              metadata: { truncated: false, extents_settled: settled, extents_asked: total },
            }),
        }),
      )
      // The error channel carries whole-call mistakes only; per-extent trouble arrives in `failed`.
      if (outcome._tag === "Failure") return refuse(outcome.failure.message)

      // No clipping here: the kernel narrows what it can before writing, and `exact` reports what it could not.
      const result = outcome.success

      const lines = OsmReport.caveats(result, {
        lostNoun: "element",
        lostRemedy: "Fetch the ones that matter with OsmGetObjects.",
        cancelled: ctx.abort.aborted
          ? "cancelled — extents not reached before it stopped were neither downloaded nor listed above."
          : undefined,
      })
      if (lines.length > 0) lines.push("")

      const asked = result.extentsAsked
      if (result.outputs.length === 0) {
        // Split because the fixes are opposite: retry extents that never answered, change tags when all answered empty.
        lines.push(
          result.extentsDone === asked
            ? `All ${asked} extent(s) answered, and nothing in them matched these tags.`
            : `No features were obtained: ${result.extentsDone} of ${asked} extent(s) answered at all.`,
        )
        return {
          title,
          output: lines.join("\n"),
          metadata: {
            truncated: false,
            error_code: "NothingObtained",
            failed: true,
            features: 0,
            extents_asked: asked,
            extents_failed: result.failed.length,
          } as Metadata,
        }
      }

      lines.push(...OsmReport.files(result, `${result.features} feature(s)`), ...OsmReport.fields(result))
      if (asked > 1) {
        lines.push(
          `Extents: ${result.extentsDone} of ${asked} completed` +
            (result.duplicates > 0 ? `; ${result.duplicates} cross-extent duplicate(s) removed.` : "."),
        )
      }
      if (result.centroidConverted > 0) {
        lines.push(
          `Centroid mode: ${result.centroidConverted} area or line feature(s) collapsed to a representative point` +
            ' (their original type is in "original_geometry").',
        )
      }

      // `incomplete` counts: an extent that answered early is in `extentsDone` and not in `failed`.
      const partial =
        result.extentsDone < asked ||
        result.unassembled.length > 0 ||
        result.failed.length > 0 ||
        result.incomplete.length > 0
      return {
        title,
        output: lines.join("\n"),
        metadata: {
          truncated: false,
          features: result.features,
          extents_done: result.extentsDone,
          extents_asked: asked,
          extents_failed: result.failed.length,
          extents_incomplete: result.incomplete.length,
          bytes: result.bytes,
          geometry: result.geometry,
          outputs: result.outputs,
          kept_fields: result.keptFields,
          dropped_fields: result.droppedFields,
          unassembled: result.unassembled,
          duplicates: result.duplicates,
          centroid_converted: result.centroidConverted,
          exact: result.exact,
          ...(partial ? { partial: true } : {}),
        } as Metadata,
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
