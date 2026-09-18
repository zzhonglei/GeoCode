import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoOsm } from "@/geo"
import DESCRIPTION from "./geo-osm-search.txt"

/* --- GeoCode: OsmSearch (docs/TOOLS.md §3); an answer built from one engine must not read like one from both. --- */

function reference(candidate: GeoOsm.OsmSearch.Candidate): string {
  const prefix = candidate.type === "relation" ? "R" : candidate.type === "way" ? "W" : "N"
  return `${prefix}${candidate.id}`
}

function formatCandidate(candidate: GeoOsm.OsmSearch.Candidate): string {
  const category = candidate.className
    ? `${candidate.className}=${candidate.classValue}${candidate.adminLevel ? ` L${candidate.adminLevel}` : ""}`
    : "-"
  // Every source label, not a "both" flag: a lone `geocoder` means the feature service's name search missed it.
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

/** Setting `truncated` skips upstream's truncation, and false holds: `OsmSearch.rank` caps the list at 25. */
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
      // Refused before the ask: an empty query becomes `rel["name"~""]`, which matches every named element.
      if (params.query.trim() === "") {
        return {
          title: params.query,
          output: '"query" is empty — name the place or entity to look for.',
          metadata: { truncated: false, error_code: "InvalidParameters", failed: true },
        }
      }

      yield* ctx.ask({
        permission: "osm",
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
      const cancelled = ctx.abort.aborted
      if (result.notes.length > 0 || cancelled) {
        lines.push(...result.notes.map((note) => `NOTE: ${note}`))
        if (cancelled) lines.push("NOTE: cancelled — the search stopped early, so these may not be all the matches.")
        lines.push("")
      }

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
          engines: result.engines,
          ...(result.notes.length > 0 ? { degraded: true } : {}),
          ...(cancelled ? { partial: true } : {}),
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
