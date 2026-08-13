import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import { OsmReport } from "./geo-osm-report"
import DESCRIPTION from "./geo-osm-objects.txt"

/* --- GeoCode: OsmGetObjects, and the shape a download tool takes
 * (docs/TOOLS.md §3, GEOKERNEL §6.7, §6.8).
 *
 * The first tool in the set that leaves something behind. Everything before it
 * answered a question; this one writes a file that will be opened later by
 * someone who was not here, and that changes what the report is for: it is the
 * only record of what the file does NOT contain.
 *
 * Three consequences run through the rendering below.
 *
 * The paths printed are the ones the KERNEL wrote, never the one that was
 * asked for. A base without a recognizable extension gets one appended (the
 * sibling names are built from it), and a run that spans several geometry
 * families is split into siblings — so the requested path can name a file that
 * does not exist (§6.7).
 *
 * Losses are named by identity, not counted. The answer to a missing object is
 * to fetch it on its own, which needs to know which one it was; "3 objects
 * were dropped" cannot be acted on at all.
 *
 * And a run that wrote nothing says so first. Nothing here overwrites — a
 * name already taken is numbered instead (§6.7) — so an empty run simply
 * creates no file, and the caller has to be told that rather than left to read
 * silence as success. --- */

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
 * `truncated: false` — §5.2's first strategy, and true by construction here.
 *
 * The data goes to disk; what comes back is a handful of paths, a geometry
 * tally and the names of what was lost. Its size follows the number of ids
 * asked for, which is capped at 25, not the size of the data.
 *
 * Failures are `error_code`, never `error: true`: that flag means an
 * environment is not ready, and this group has no environment (§6.2).
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
      const title = params.output

      // Asked BEFORE the call, because the call is what writes: the kernel
      // creates directories and replaces files inside `downloadObjects`, so
      // there is no later point at which permission would still mean anything.
      // The pattern is the path, which is the thing being acted on (§4.3).
      yield* ctx.ask({
        permission: "osm",
        patterns: [params.output],
        always: ["*"],
        metadata: { ids: params.ids, output: params.output },
      })

      const outcome = yield* Effect.result(
        osm.downloadObjects({
          ids: params.ids,
          output: params.output,
          fields: params.fields,
          abort: ctx.abort,
        }),
      )
      // Whole-call mistakes only — more ids than one call takes, or not one
      // parseable id among them. Per-object trouble never arrives here; it
      // arrives as `failed`, alongside a file that holds everything else.
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

      // The kernel names these fields for extents because it shares the shape
      // with the extent-driven download; here they hold objects.
      const asked = result.extentsAsked

      if (result.outputs.length === 0) {
        // That no file exists is the kernel's note, printed above. This line
        // carries the half that note cannot: how much was asked for.
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

      // `incomplete` counts here too: a service that answered early is a real
      // shortfall that does not look like one (§6.3).
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
