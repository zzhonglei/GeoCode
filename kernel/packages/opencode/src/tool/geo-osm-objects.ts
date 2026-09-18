import * as path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-objects.txt"

/* --- GeoCode: OsmGetObjects (docs/TOOLS.md §3). The report is the only record of what the written file lacks
 * (GEOKERNEL §6.7). --- */

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
 * Setting `truncated` skips upstream's truncation, and false holds because the data goes to disk (docs/TOOLS.md
 * §5.2). Failures use `error_code`, never `error: true`, which means an environment is not ready.
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
      // Resolved here: the kernel would resolve a relative path against the process cwd, not the instance directory.
      const instance = yield* InstanceState.context
      let filepath = params.output
      if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
      if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)
      const title = path.relative(instance.worktree, filepath)

      // Asked before the call, which writes files; the pattern is worktree-relative.
      yield* ctx.ask({
        permission: "osm",
        patterns: [title],
        always: ["*"],
        metadata: { ids: params.ids, output: filepath },
      })

      // The boundary guard after the capability, the reverse of upstream `write`: `osm` is denied to every agent but
      // osmfetch (config/geocode.ts), so guarding first would ask about a directory for a call that cannot run.
      yield* assertExternalDirectoryEffect(ctx, filepath)

      const outcome = yield* Effect.result(
        osm.downloadObjects({
          ids: params.ids,
          output: filepath,
          fields: params.fields,
          abort: ctx.abort,
          onProgress: (settled, total) =>
            ctx.metadata({
              title,
              metadata: { truncated: false, objects_settled: settled, objects_asked: total },
            }),
        }),
      )
      // The error channel carries whole-call mistakes only; per-object trouble arrives in `failed`.
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

      // `incomplete` counts even when the per-object fallback filled what the batched fetch dropped.
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
