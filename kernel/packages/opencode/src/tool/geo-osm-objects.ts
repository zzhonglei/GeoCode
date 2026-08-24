import * as path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-objects.txt"

/* --- GeoCode: OsmGetObjects (docs/TOOLS.md §3, GEOKERNEL §6.7, §6.8). The file it writes is opened later by
 * someone who was not here, so the report is the only record of what the file does not hold: the paths the kernel
 * wrote rather than the one asked for, losses named by id so the caller can refetch them, and a run that wrote
 * nothing saying so — nothing here overwrites, so an empty run just leaves no file (§6.7). --- */

export const Parameters = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description:
      'OSM object ids with an R/W/N prefix, e.g. ["R10717504", "R20406341"]. At most 25 in one call; for "every X inside an area" use OsmGetFeatures instead.',
  }),
  output: Schema.String.annotate({
    description:
      "Absolute path for the result. A path not ending in .geojson gets it appended, and the report names the file(s) actually written.",
  }),
  fields: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Extra tag keys to keep as columns, e.g. ["admin_level"]. By default only the core identity columns survive; other tags are dropped and reported by key. Pass ["*"] to keep all tags losslessly in an "osm_tags" column.',
  }),
})

/**
 * Setting `truncated` at all skips upstream's truncation (tool.ts), and false is honest: the data goes to disk, so
 * the output follows the number of ids, capped at `GeoOsm.MAX_IDS` (docs/TOOLS.md §5.2). Failures are `error_code`,
 * never `error: true`, which means an environment is not ready and this group has none to be (§6.2).
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const OsmGetObjectsTool = Tool.define<typeof Parameters, Metadata, GeoOsm.Service>(
  "OsmGetObjects",
  Effect.gen(function* () {
    const osm = yield* GeoOsm.Service

    const run = Effect.fn("OsmGetObjectsTool.execute")(function* (
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

      // Before the call, because the call is what writes: `downloadObjects` creates directories and files. The
      // pattern is worktree-relative, the form every path rule in this product is written against (§4.3).
      yield* ctx.ask({
        permission: "osm",
        patterns: [title],
        always: ["*"],
        metadata: { ids: params.ids, output: filepath },
      })

      // Then the boundary, the reverse of upstream's `write`: `osm` is denied for every agent but osmfetch
      // (config/geocode.ts), so guarding first would raise a prompt about a directory for a call that was never
      // going to run. Ask what the caller may do, then where it may write.
      yield* assertExternalDirectoryEffect(ctx, filepath)

      const outcome = yield* Effect.result(
        osm.downloadObjects({
          ids: params.ids,
          output: filepath,
          fields: params.fields,
          abort: ctx.abort,
          // The reserved per-unit channel (§6.2), worded for objects: the batched query settles most of them in one
          // step, and the per-object fallback behind it is the part a count can describe.
          onProgress: (settled, total) =>
            ctx.metadata({
              title,
              metadata: { truncated: false, objects_settled: settled, objects_asked: total },
            }),
        }),
      )
      // Whole-call mistakes only — more ids than one call takes, or not one parseable id among them. Per-object
      // trouble arrives as `failed`, alongside a file that holds everything else.
      if (outcome._tag === "Failure") {
        return {
          title,
          output: outcome.failure.message,
          metadata: { truncated: false, error_code: "InvalidParameters", failed: true } as Metadata,
        }
      }
      const result = outcome.success

      const lines = OsmReport.caveats(result, {
        lostNoun: "object",
        cancelled: ctx.abort.aborted
          ? "cancelled — objects not reached before it stopped were neither fetched nor reported by id."
          : undefined,
      })
      if (lines.length > 0) lines.push("")

      // Extent-named because `DownloadResult` is shared with the extent-driven download; here they count objects.
      const asked = result.extentsAsked

      if (result.outputs.length === 0) {
        // That no file exists is the kernel's note, printed above; this line adds how much was asked for.
        lines.push(`None of the ${asked} requested object(s) could be obtained.`)
        return {
          title,
          output: lines.join("\n"),
          metadata: {
            truncated: false,
            error_code: "NothingObtained",
            failed: true,
            objects_asked: asked,
            objects_failed: result.failed.length,
          } as Metadata,
        }
      }

      const scope = result.features === asked ? `${asked} object(s)` : `${result.features} of ${asked} object(s)`
      lines.push(...OsmReport.files(result, scope), ...OsmReport.fields(result))
      if (result.duplicates > 0) {
        lines.push(`The same object arrived more than once and was kept once: ${result.duplicates} duplicate(s).`)
      }

      // `incomplete` counts too, and it can be the only one set: the batched fetch reporting a truncated answer
      // makes the run partial even where the per-object fallback then filled the gap (§6.3).
      const partial =
        result.features < asked ||
        result.unassembled.length > 0 ||
        result.failed.length > 0 ||
        result.incomplete.length > 0
      return {
        title,
        output: lines.join("\n"),
        metadata: {
          truncated: false,
          objects: result.features,
          objects_asked: asked,
          objects_failed: result.failed.length,
          bytes: result.bytes,
          geometry: result.geometry,
          outputs: result.outputs,
          kept_fields: result.keptFields,
          dropped_fields: result.droppedFields,
          unassembled: result.unassembled,
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
