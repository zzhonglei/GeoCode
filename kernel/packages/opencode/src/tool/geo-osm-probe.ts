import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import DESCRIPTION from "./geo-osm-probe.txt"

/* --- GeoCode: OsmProbe, the step that makes the OSM group a workflow
 * (docs/TOOLS.md §3, GEOKERNEL §6.8).
 *
 * Reconnaissance exists because of how public services answer a query that is
 * too big: not with an error, but with a timeout or a truncation that arrives
 * looking like data. Knowing the size beforehand is the difference between a
 * download and a mystery, and that is the whole reason the four capabilities
 * are a workflow rather than a list.
 *
 * Like the rest of this group there is no environment, no gate and no
 * guidance (§6.2). What the tool layer owns here is the numbers' CAVEATS — an
 * approximated boundary, a service that answered early, an extent that never
 * answered. Each one changes what the numbers mean, and none of them is
 * visible in the numbers themselves. So they are printed first, before the
 * figures they qualify: a reader who meets them afterwards has already read
 * the figures as complete. --- */

/** Values printed before the tail is summarized. The old build settled on this. */
const TOP_VALUES = 30

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
 * `truncated: false` is a claim about this tool, and a sound one.
 *
 * Both modes are bounded by construction — one line per extent, and a value
 * list cut to `TOP_VALUES` with the remainder summarized — so the size of this
 * output does not follow the size of the area. §5.2's first strategy, and the
 * declaration is what keeps upstream's head truncation away from an answer
 * whose caveats sit at the top and whose totals sit at the bottom.
 *
 * Failures are `error_code`, never `error: true`: that flag is reserved for an
 * environment that is not ready, and this group has no environment to be
 * (§6.2). Everything that can go wrong here is data or parameters.
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

/**
 * The caveats, in the order they change the reading.
 *
 * A widened boundary rescales every number at once, so it comes first; an
 * incomplete answer and a failed extent are per-extent and follow. The
 * service's own wording is carried through verbatim rather than summarized as
 * "incomplete" — "timed out" and "this query is too broad" ask the caller to
 * do opposite things, and only the service knows which one happened
 * (§6.3 第四种失败).
 */
function caveats(
  result: {
    readonly exact?: boolean
    readonly incomplete: readonly GeoOsm.Incomplete[]
    readonly failed: readonly GeoOsm.Failure[]
  },
  verb: string,
): string[] {
  const lines: string[] = []
  if (result.exact === false) {
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
  return lines
}

/** What the caller wrote, echoed rather than the normalized form they did not. */
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

      // Asymmetric, and deliberately so. A blank `key` means the parameter was
      // not given — one value, and empty is absent. A blank entry among tags is
      // a mistake in a list of real ones, so it is passed through: the kernel
      // refuses the whole call by name, where dropping it here would count the
      // rest and never mention what went missing.
      const tags = params.tags ?? []
      const key = params.key?.trim() ?? ""
      // Exactly one. Both modes at once has no meaning, and neither leaves
      // nothing to ask — the two mistakes are the same mistake seen twice, so
      // they get the same sentence naming both options.
      if ((tags.length > 0) === (key !== "")) {
        return refuse(
          "InvalidParameters",
          'Give exactly one of "tags" (count mode) or "key" (distribution mode) — this call gave ' +
            (key !== "" ? "both." : "neither."),
        )
      }
      // Refused rather than answered, because the kernel would answer it: with
      // no extent the loop never runs and every figure comes back zero, which
      // is indistinguishable from an area that genuinely holds nothing.
      if (params.extents.length === 0) {
        return refuse("InvalidParameters", '"extents" is empty — name at least one area to look in.')
      }

      yield* ctx.ask({
        permission: "osm",
        patterns: [...params.extents],
        always: ["*"],
        metadata: { extents: params.extents, ...(key !== "" ? { key } : { tags }) },
      })

      const asked = params.extents.length
      /**
       * Nothing came back — one event told twice, so it gets one sentence.
       * Every extent failed, or the user stopped the call; the caveats already
       * printed carry the reasons, this only says nothing survived them.
       */
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

      if (key !== "") {
        const outcome = yield* Effect.result(
          osm.distribution({ extents: params.extents, key, types: params.types, abort: ctx.abort }),
        )
        // The kernel's error channel holds whole-call mistakes only — too many
        // extents, a tag or type list it cannot parse. Per-extent trouble never
        // arrives here; it arrives as `failed`.
        if (outcome._tag === "Failure") return refuse("InvalidParameters", outcome.failure.message)
        const result = outcome.success
        const lines = caveats(result, "sampled")
        // With the other caveats, not below the list it qualifies. The cap
        // bounds what comes BACK, not what is there: every count under it is a
        // floor and a rare value can be absent altogether, which is the first
        // thing to know about this list rather than a footnote to it.
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

        if (result.distinct === 0) {
          lines.push(`No element inside these ${asked} extent(s) carries the key "${key}" (types ${typesLabel(params.types)}).`)
        } else {
          const shown = result.values.slice(0, TOP_VALUES)
          const width = column(
            shown.map((entry) => entry.value),
            8,
          )
          // Right-aligned, because a column of counts is read by comparing
          // them, and ragged digits make that a per-line act.
          const figures = column(
            shown.map((entry) => String(entry.count)),
            1,
          )
          lines.push(
            `Values of "${key}" across ${asked} extent(s), types ${typesLabel(params.types)} —` +
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
      const lines = caveats(result, "counted")
      if (lines.length > 0) lines.push("")

      if (result.perExtent.length === 0) {
        return nothing(lines, "counted", result.failed.length, { mode: "count" })
      }

      const scope =
        result.perExtent.length === asked
          ? `${asked} extent(s)`
          : `${result.perExtent.length} of ${asked} extent(s)`
      const width = column(
        result.perExtent.map((entry) => entry.extent),
        3,
      )
      // Right-aligned. The point of asking about several extents at once is to
      // compare them (§6.8), and a ragged column turns a glance into arithmetic.
      const figures = column(
        [...result.perExtent.map((entry) => String(entry.total)), String(result.totals.total)],
        1,
      )
      const row = (label: string, counts: { total: number; nodes: number; ways: number; relations: number }) =>
        `  ${label.padEnd(width)}  total ${String(counts.total).padStart(figures)}` +
        `  (nodes ${counts.nodes}, ways ${counts.ways}, relations ${counts.relations})`
      lines.push(`Counted [${tags.join(", ")}] across ${scope}, types ${typesLabel(params.types)}:`, "")
      for (const entry of result.perExtent) lines.push(row(entry.extent, entry))
      // Only when there is something to sum. On a single extent the row would
      // repeat the one above it and invite it to be read as a second area.
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
