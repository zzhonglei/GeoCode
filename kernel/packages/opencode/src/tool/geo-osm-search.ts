import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import DESCRIPTION from "./geo-osm-search.txt"

/* --- GeoCode: OsmSearch, the first step of the OSM workflow
 * (docs/TOOLS.md §3, GEOKERNEL §6.8).
 *
 * The OSM group is shaped unlike the other two, and this file is where that
 * shows for the first time (§6.2). There is no configuration, no environment
 * probe, no status slot and no gate — so no environment header, no settling
 * wait, and no guidance for a state the user could fix. Reliability is not a
 * property of an install here; it is solved inside each call, by an endpoint
 * pool and failover the kernel owns.
 *
 * What that leaves this layer is presentation, and one job that matters more
 * than it looks: a degraded answer must not read like a complete one. The
 * search asks two engines whose recall sets differ a lot, and when one of them
 * does not answer the other's results are still returned — correctly, but they
 * are half the answer. The notes are what say so. --- */

/** The kernel ranks and caps; this is only the shape of a printed line. */
function reference(candidate: GeoOsm.OsmSearch.Candidate): string {
  const prefix = candidate.type === "relation" ? "R" : candidate.type === "way" ? "W" : "N"
  return `${prefix}${candidate.id}`
}

function formatCandidate(candidate: GeoOsm.OsmSearch.Candidate): string {
  const category = candidate.className
    ? `${candidate.className}=${candidate.classValue}${candidate.adminLevel ? ` L${candidate.adminLevel}` : ""}`
    : "-"
  // Every source that matched, not a "both" flag: which engine found something
  // is a diagnosis when only one did, and the count is the confidence signal
  // when more than one did. The old build's description promised "[both]" while
  // its code printed the engine names — the code had it right.
  const sources = `[${[...candidate.sources].join("+")}]`
  const importance = candidate.importance !== undefined ? `  imp=${candidate.importance.toFixed(3)}` : ""
  const center = candidate.center
    ? `  center=${candidate.center.lat.toFixed(4)},${candidate.center.lon.toFixed(4)}`
    : ""
  const transit = candidate.transit ? "  (transit)" : ""
  const lines = [`${reference(candidate)}  ${candidate.type}  ${category}  ${sources}${importance}${center}${transit}`]
  const label = candidate.displayName ?? candidate.name
  if (label) lines.push(`    ${label}`)
  if (candidate.siteParent) lines.push(`    (member of site relation ${candidate.siteParent})`)
  return lines.join("\n")
}

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: 'The place or entity name, e.g. "武汉大学", "中国地质大学武汉", "Mount Tai".',
  }),
  context: Schema.optional(Schema.String).annotate({
    description:
      'Optional geographic context for disambiguation, e.g. "武汉" / "山东". Strongly improves ranking when the name exists in many regions.',
  }),
  category: Schema.optional(Schema.String).annotate({
    description: 'Optional OSM tag hint to narrow results, e.g. "amenity=university", "boundary=administrative".',
  }),
})

/**
 * `truncated: false` is a claim about this tool, and a sound one.
 *
 * The kernel ranks and caps the candidate list, so the size of this output is
 * bounded by that cap and a line's width — not by how much data the area
 * holds. This is §5.2's first strategy: the tools that cannot produce a flood
 * say so, and the declaration keeps upstream's head-truncation off an answer
 * whose closing lines are the advice for when nothing matched.
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const OsmSearchTool = Tool.define<typeof Parameters, Metadata, GeoOsm.Service>(
  "OsmSearch",
  Effect.gen(function* () {
    const osm = yield* GeoOsm.Service

    const run = Effect.fn("OsmSearchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      yield* ctx.ask({
        permission: "geo_osm_search",
        patterns: [params.query],
        always: ["*"],
        metadata: { query: params.query },
      })

      const result = yield* osm.search({
        query: params.query,
        context: params.context,
        category: params.category,
        abort: ctx.abort,
      })

      const lines: string[] = []
      // Notes first, and never folded into the candidate list: they describe
      // the answer as a whole, and an answer built from one engine instead of
      // two is not wrong — it is incomplete in a way only this can say.
      if (result.notes.length > 0) lines.push(...result.notes.map((note) => `NOTE: ${note}`), "")

      if (result.candidates.length === 0) {
        lines.push(
          `No matches for "${params.query}" — the geocoder and the feature service both came back empty.`,
          "Adapt the query: expand abbreviations to the full official name, add `context`, try another language",
          "(names are often tagged name:en), or drop the name search and go by extent + tags with OsmProbe.",
        )
      } else {
        lines.push(`Found ${result.candidates.length} candidate(s) for "${params.query}":`, "")
        for (const candidate of result.candidates) lines.push(formatCandidate(candidate))
      }

      return {
        title: params.query,
        output: lines.join("\n"),
        metadata: {
          truncated: false,
          candidates: result.candidates.length,
          // Per engine, because the merge hides which one answered — and one
          // engine silent is the difference between "no such place" and "half
          // the search ran" (§6.8 任一单独使用都会漏).
          engines: result.engines,
          ...(result.notes.length > 0 ? { degraded: true } : {}),
        },
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
