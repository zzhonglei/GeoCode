import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
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

function kilobytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
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
        permission: "geo_osm_objects",
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

      // Caveats first, before the figures they qualify (the rule OsmProbe
      // established). Here they carry more weight than there: this is the only
      // place the absence of an object is ever mentioned, and the file itself
      // will not say a word about what is not in it.
      const lines: string[] = []
      // The kernel's own prose, which is where the protection announces itself
      // ("nothing was obtained, so any existing output file was left as it
      // was") as well as the fallback route being taken.
      for (const note of result.notes) lines.push(`NOTE: ${note}`)
      for (const entry of result.incomplete) {
        lines.push(`NOTE: ${entry.extent} came back incomplete. The service said: ${entry.remark}`)
      }
      for (const entry of result.failed) lines.push(`NOTE: ${entry.extent} — ${entry.reason}`)
      if (result.unassembled.length > 0) {
        // By identity: the fix for a dropped object is to ask for it alone.
        lines.push(
          `NOTE: ${result.unassembled.length} object(s) matched but produced no geometry —` +
            ` ${result.unassembled.join(", ")}`,
        )
      }
      if (ctx.abort.aborted) {
        lines.push("NOTE: cancelled — objects not reached before it stopped were neither fetched nor reported by id.")
      }
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
      if (result.outputs.length === 1) {
        lines.push(`Wrote ${scope} to ${result.outputs[0]!.path} (${kilobytes(result.bytes)}).`)
      } else {
        const width = Math.max(...result.outputs.map((entry) => entry.path.length))
        // Why it splits is a design decision, and it lives in the comment at the
        // top of this file. What the caller needs is the list.
        lines.push(
          `Mixed geometry families, so the result was split into ${result.outputs.length} files` +
            ` — ${scope}, ${kilobytes(result.bytes)}:`,
          "",
        )
        for (const entry of result.outputs) {
          lines.push(`  ${entry.path.padEnd(width)}  ${entry.family}: ${entry.count}`)
        }
        lines.push("")
      }

      const geometry = Object.entries(result.geometry)
        .map(([type, count]) => `${type}×${count}`)
        .join(", ")
      lines.push(`Geometry: ${geometry || "none"}.  CRS: EPSG:4326.`, `Fields kept: ${result.keptFields.join(", ")}.`)
      lines.push(
        result.droppedFields.length > 0
          ? `Fields dropped: ${result.droppedFields.join(", ")} — ask again with fields:[...] to keep any of them,` +
              ' or fields:["*"] for a lossless osm_tags column.'
          : "Fields dropped: none.",
      )
      if (result.duplicates > 0) {
        lines.push(`The same object arrived more than once and was kept once: ${result.duplicates} duplicate(s).`)
      }

      const partial = result.features < asked || result.unassembled.length > 0 || result.failed.length > 0
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
