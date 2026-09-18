import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import DESCRIPTION from "./geo-osm-probe.txt"

/* --- GeoCode: OsmProbe, the reconnaissance step (docs/TOOLS.md §3). Caveats go above the numbers, since none of
 * them shows in the numbers themselves. --- */

const TOP_VALUES = 30

const CANCELLED = "cancelled — extents not reached before it stopped contributed nothing to these numbers."

export const Parameters = Schema.Struct({
  extents: Schema.Array(Schema.String).annotate({
    description:
      'One or more extents (same forms as OsmGetFeatures): "area:R<id>", "bbox:S,W,N,E", "around:radius_m,lat,lon", "file:/abs/path.geojson". Probing candidate sub-areas in one call returns them side by side.',
  }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Count mode: the tag filters to count, as a union, e.g. ["amenity=hospital", "healthcare"]. Give either tags or key, not both.',
  }),
  key: Schema.optional(Schema.String).annotate({
    description:
      'Distribution mode: one tag key, e.g. "amenity", whose value distribution inside the extents is reported. Give either tags or key, not both.',
  }),
  types: Schema.optional(Schema.String).annotate({
    description: 'Element types: "nwr" (default, all), or a comma list of node/way/relation.',
  }),
})

/**
 * Setting `truncated` skips upstream's head truncation, which would drop the totals, and false holds: one line per
 * extent and at most `TOP_VALUES` values (docs/TOOLS.md §5.2). Failures use `error_code`, never `error: true`, which
 * means an environment is not ready.
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

/** The service's remark is quoted verbatim: "timed out" and "this query is too broad" ask for opposite fixes. */
function caveats(
  result: {
    /** Required rather than optional: an omitted field is falsy here, so the note below would print on every run. */
    readonly exact: boolean
    readonly incomplete: readonly GeoOsm.Incomplete[]
    readonly failed: readonly GeoOsm.Failure[]
  },
  verb: string,
  cancelled?: string,
): string[] {
  const lines: string[] = []
  if (!result.exact) {
    lines.push(
      "NOTE: a boundary was too detailed or too fragmented to filter exactly, so it was widened outward." +
        " These numbers cover more ground than the boundary asked for — read them as an upper bound.",
    )
  }
  for (const entry of result.incomplete) {
    lines.push(`NOTE: ${entry.extent} came back incomplete. The service said: ${entry.remark}`)
  }
  for (const entry of result.failed) {
    lines.push(`NOTE: ${entry.extent} was not ${verb} — ${entry.reason}`)
  }
  if (cancelled) lines.push(`NOTE: ${cancelled}`)
  return lines
}

function typesLabel(types: string | undefined): string {
  return types?.trim() || "nwr"
}

function column(values: readonly string[], floor: number): number {
  return Math.max(floor, ...values.map((value) => value.length))
}

export const OsmProbeTool = Tool.define<typeof Parameters, Metadata, GeoOsm.Service>(
  "OsmProbe",
  Effect.gen(function* () {
    const osm = yield* GeoOsm.Service

    const run = Effect.fn("OsmProbeTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const title = params.extents.join(", ")
      const refuse = (code: string, message: string) => ({
        title,
        output: message,
        metadata: { truncated: false, error_code: code, failed: true } as Metadata,
      })

      // A blank `key` counts as absent, but blank tags are left for the kernel to refuse by name, not dropped silently.
      const tags = params.tags ?? []
      const key = params.key?.trim() ?? ""
      const counting = tags.length > 0
      const distributing = key !== ""
      if (counting === distributing) {
        return refuse(
          "InvalidParameters",
          'Give exactly one of "tags" (count mode) or "key" (distribution mode) — this call gave ' +
            (distributing ? "both." : "neither."),
        )
      }
      // Refused here: the kernel would answer with zeros, which reads as an area holding nothing.
      if (params.extents.length === 0) {
        return refuse("InvalidParameters", '"extents" is empty — name at least one area to look in.')
      }

      yield* ctx.ask({
        permission: "osm",
        patterns: [...params.extents],
        always: ["*"],
        metadata: { extents: params.extents, ...(distributing ? { key } : { tags }) },
      })

      const asked = params.extents.length
      const nothing = (lines: string[], verb: string, failed: number, mode: Record<string, unknown>) => {
        const aborted = ctx.abort.aborted
        lines.push(
          aborted ? `Cancelled before any extent was ${verb}.` : `None of the ${asked} extent(s) could be ${verb}.`,
        )
        return {
          title,
          output: lines.join("\n"),
          metadata: {
            truncated: false,
            ...mode,
            error_code: aborted ? "Cancelled" : "AllExtentsFailed",
            failed: true,
            extents_asked: asked,
            extents_failed: failed,
          } as Metadata,
        }
      }

      if (distributing) {
        const outcome = yield* Effect.result(
          osm.distribution({ extents: params.extents, key, types: params.types, abort: ctx.abort }),
        )
        // The error channel carries whole-call mistakes only; per-extent trouble arrives in `failed`.
        if (outcome._tag === "Failure") return refuse("InvalidParameters", outcome.failure.message)
        const result = outcome.success
        const lines = caveats(result, "sampled", ctx.abort.aborted && result.sampled > 0 ? CANCELLED : undefined)
        if (result.truncated) {
          lines.push(
            "NOTE: an extent reached the sample cap, so these counts are a lower bound and rare values may be" +
              " missing from the list entirely.",
          )
        }
        if (lines.length > 0) lines.push("")

        if (result.failed.length >= asked || (ctx.abort.aborted && result.sampled === 0)) {
          return nothing(lines, "sampled", result.failed.length, { mode: "distribution", key })
        }

        const scope = result.answered === asked ? `${asked} extent(s)` : `${result.answered} of ${asked} extent(s)`

        if (result.distinct === 0) {
          lines.push(`No element inside ${scope} carries the key "${key}" (types ${typesLabel(params.types)}).`)
        } else {
          const shown = result.values.slice(0, TOP_VALUES)
          const width = column(
            shown.map((entry) => entry.value),
            8,
          )
          const figures = column(
            shown.map((entry) => String(entry.count)),
            1,
          )
          lines.push(
            `Values of "${key}" across ${scope}, types ${typesLabel(params.types)} —` +
              ` ${result.sampled} element(s) sampled, ${result.distinct} distinct value(s):`,
            "",
          )
          for (const entry of shown) {
            lines.push(`  ${entry.value.padEnd(width)}  ${String(entry.count).padStart(figures)}`)
          }
          if (result.distinct > shown.length) {
            lines.push(`  ... and ${result.distinct - shown.length} more value(s)`)
          }
        }

        return {
          title,
          output: lines.join("\n"),
          metadata: {
            truncated: false,
            mode: "distribution",
            key,
            distinct: result.distinct,
            sampled: result.sampled,
            sample_capped: result.truncated,
            exact: result.exact,
            extents_answered: result.answered,
            extents_asked: asked,
            extents_failed: result.failed.length,
            extents_incomplete: result.incomplete.length,
          } as Metadata,
        }
      }

      const outcome = yield* Effect.result(
        osm.count({ extents: params.extents, tags, types: params.types, abort: ctx.abort }),
      )
      if (outcome._tag === "Failure") return refuse("InvalidParameters", outcome.failure.message)
      const result = outcome.success
      const lines = caveats(result, "counted", ctx.abort.aborted && result.perExtent.length > 0 ? CANCELLED : undefined)
      if (lines.length > 0) lines.push("")

      if (result.perExtent.length === 0) {
        return nothing(lines, "counted", result.failed.length, { mode: "count" })
      }

      const scope =
        result.perExtent.length === asked ? `${asked} extent(s)` : `${result.perExtent.length} of ${asked} extent(s)`
      const width = column(
        result.perExtent.map((entry) => entry.extent),
        3,
      )
      const figures = column([...result.perExtent.map((entry) => String(entry.total)), String(result.totals.total)], 1)
      const row = (label: string, counts: { total: number; nodes: number; ways: number; relations: number }) =>
        `  ${label.padEnd(width)}  total ${String(counts.total).padStart(figures)}` +
        `  (nodes ${counts.nodes}, ways ${counts.ways}, relations ${counts.relations})`
      lines.push(`Counted [${tags.join(", ")}] across ${scope}, types ${typesLabel(params.types)}:`, "")
      for (const entry of result.perExtent) lines.push(row(entry.extent, entry))
      if (result.perExtent.length > 1) lines.push(row("SUM", result.totals))

      return {
        title,
        output: lines.join("\n"),
        metadata: {
          truncated: false,
          mode: "count",
          total: result.totals.total,
          nodes: result.totals.nodes,
          ways: result.totals.ways,
          relations: result.totals.relations,
          exact: result.exact,
          extents_counted: result.perExtent.length,
          extents_asked: asked,
          extents_failed: result.failed.length,
          extents_incomplete: result.incomplete.length,
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
