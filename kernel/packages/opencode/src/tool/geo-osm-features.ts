import * as path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-features.txt"

/* --- GeoCode: OsmGetFeatures, the bulk download (docs/TOOLS.md §3, GEOKERNEL §6.4, §6.7, §6.8). A file of the
 * wrong features looks exactly like a file of the right ones, so two of the report's lines are data contracts: a
 * widened boundary leaves the result a superset of what was asked for (§6.4), and the centroid count measures what
 * a point-only query would have missed (§6.8). --- */

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
 * Setting `truncated` at all skips upstream's truncation (tool.ts), and false is honest: the features go to disk,
 * so the output follows the extent count and the dropped tag keys, never the feature count (docs/TOOLS.md §5.2).
 * Failures are `error_code`, never `error: true`, which means an environment is not ready and this group has none
 * to be (§6.2).
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
      // Resolved here rather than left to the kernel: `osm/output.ts` hands the path straight to `mkdirSync`, so a
      // relative one would land against the process cwd instead of the instance directory (§4.3).
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

      // Both refused rather than answered, because the kernel would answer them: it bounds the extent count and
      // nothing else, so an empty extent list loops zero times and an empty tag list builds an empty union — either
      // way zero features come back, which is what an area holding none of this category looks like.
      if (params.extents.length === 0) {
        return refuse('"extents" is empty — name at least one area to download from.')
      }
      if (params.tags.length === 0) {
        return refuse('"tags" is empty — name at least one tag filter, e.g. ["amenity=hospital"].')
      }

      // Before the call, because the call is what writes: `downloadFeatures` creates directories and files, and a
      // "file:" extent reads a boundary off disk on the way there. The pattern is worktree-relative, the form every
      // path rule in this product is written against (§4.3).
      yield* ctx.ask({
        permission: "osm",
        patterns: [title],
        always: ["*"],
        metadata: { extents: params.extents, tags: params.tags, output: filepath },
      })

      // Then the boundary — after the capability and after the refusals above, so neither a malformed call nor one
      // from an agent without `osm` ever raises a prompt about a directory (the order OsmGetObjects explains).
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
          // The reserved per-unit channel (§6.2). `extents_settled` counts failures too; `extents_done` does not.
          onProgress: (settled, total) =>
            ctx.metadata({
              title,
              metadata: { truncated: false, extents_settled: settled, extents_asked: total },
            }),
        }),
      )
      // Whole-call mistakes only — more extents than one call takes, a tag or type list the builder cannot parse.
      // Per-extent trouble arrives as `failed`, beside a file holding everything else.
      if (outcome._tag === "Failure") return refuse(outcome.failure.message)

      // No clipping here: where a widened boundary can be narrowed back the kernel does it before writing and
      // before counting (§6.4, `osm/intersect.ts`), and where it cannot, `exact` below says so.
      const result = outcome.success

      const lines = OsmReport.caveats(result, {
        lostNoun: "element",
        // Named because this caller can act on it: an agent holding the `osm` key holds OsmGetObjects too.
        lostRemedy: "Fetch the ones that matter with OsmGetObjects.",
        cancelled: ctx.abort.aborted
          ? "cancelled — extents not reached before it stopped were neither downloaded nor listed above."
          : undefined,
      })
      if (lines.length > 0) lines.push("")

      const asked = result.extentsAsked
      if (result.outputs.length === 0) {
        // Two cases the kernel's "no file was written" note cannot separate, and they ask for opposite responses:
        // a service that never answered is retried, a service that answered with nothing means the tags are wrong.
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
      // With the facts rather than the caveats — the extents that did not finish are already named above — and only
      // above one extent, since a single one makes this restate the line before it.
      if (asked > 1) {
        lines.push(
          `Extents: ${result.extentsDone} of ${asked} completed` +
            (result.duplicates > 0 ? `; ${result.duplicates} cross-extent duplicate(s) removed.` : "."),
        )
      }
      if (result.centroidConverted > 0) {
        // What a point-only query would have missed — often most of the answer (§6.8).
        lines.push(
          `Centroid mode: ${result.centroidConverted} area or line feature(s) collapsed to a representative point` +
            ' (their original type is in "original_geometry").',
        )
      }

      // `incomplete` counts: the kernel raises `extentsDone` for an extent that answered early and leaves it out of
      // `failed`, so without this a short answer reads as a whole one (§6.3).
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
          // False means the file covers more ground than the extents asked for; the caveat above names which
          // boundary was widened.
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
