import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoStatus } from "@/geo"
import { GeoTool } from "./geo-tool"
import DESCRIPTION from "./geo-qgis-doc.txt"

/* --- GeoCode: QgisDoc, queries against the in-memory algorithm catalog (docs/TOOLS.md §3). Output is bounded by
 * the QGIS install rather than by user data, which is what makes `truncated: false` true. --- */

const QGIS_PROCESSING_DOCS = "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs"

const SEARCH_LIMIT = 10

type Named = { readonly id: string; readonly name: string; readonly group: string }

/** The anchor slugs the DISPLAY NAME, never the id, which breaks every multi-word name (GEOKERNEL §4.11). */
export function docsUrl(algorithm: Named): string {
  const provider = algorithm.id.startsWith("gdal:")
    ? "gdal"
    : algorithm.id.startsWith("native:") || algorithm.id.startsWith("qgis:")
      ? "qgis"
      : undefined
  if (!provider) return `${QGIS_PROCESSING_DOCS}/index.html`
  // The page slug deletes non-alphanumerics where the anchor below dashes them; not the same rule.
  const page = algorithm.group.toLowerCase().replace(/[^a-z0-9]/g, "")
  // An algorithm declaring no group has no page to link to.
  if (!page) return `${QGIS_PROCESSING_DOCS}/index.html`
  const anchor = algorithm.name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${QGIS_PROCESSING_DOCS}/${provider}/${page}.html#${anchor}`
}

/**
 * QGIS's help text goes out VERBATIM, with only the required and defaulted parameters added above it; the structured
 * listing is for algorithms that export no help text (GEOKERNEL §4.11).
 */
export function formatAlgorithm(algorithm: GeoQgis.QgisCatalog.Algorithm): string {
  const required = algorithm.parameters.filter((param) => !param.optional)
  const withDefaults = algorithm.parameters.filter((param) => param.defaultValue !== null)
  const lines: string[] = []
  lines.push(`Algorithm: ${algorithm.id}`)
  lines.push(`Name: ${algorithm.name}`)
  // The name groups() lists ungrouped algorithms under, so list_algorithms accepts what is printed here.
  lines.push(`Group: ${algorithm.group || GeoQgis.QgisCatalog.UNGROUPED}`)
  lines.push("")

  if (algorithm.helpText) {
    if (required.length > 0) {
      lines.push(`Required: ${required.map((param) => param.name).join(", ")}`)
      lines.push("")
    }
    if (withDefaults.length > 0) {
      lines.push("Defaults:")
      for (const param of withDefaults) lines.push(`  ${param.name}: ${param.defaultValue}`)
      lines.push("")
    }
    lines.push("Raw QGIS help:")
    lines.push(algorithm.helpText)
    lines.push("")
  } else {
    if (algorithm.description) {
      lines.push("Description:")
      lines.push(algorithm.description)
      lines.push("")
    }
    if (algorithm.parameters.length > 0) {
      lines.push("Parameters from QGIS API:")
      for (const param of algorithm.parameters) {
        const fallback = param.defaultValue !== null ? `, default: ${param.defaultValue}` : ""
        lines.push(`- ${param.name}`)
        lines.push(`  Type: ${param.type}`)
        lines.push(`  Required: ${param.optional ? "no" : "yes"}${fallback}`)
        lines.push(`  Description: ${param.description || "(none from QGIS)"}`)
        if (param.options.length > 0) {
          lines.push("  Options from QGIS API:")
          param.options.forEach((option, index) => lines.push(`    ${index}: ${option}`))
        }
      }
      lines.push("")
    }
    if (required.length > 0) {
      lines.push("Required parameter names:")
      for (const param of required) lines.push(`- ${param.name}`)
      lines.push("")
    }
    if (algorithm.outputs.length > 0) {
      lines.push("Outputs from QGIS API:")
      for (const output of algorithm.outputs) {
        lines.push(`- ${output.name} (${output.type}) - ${output.description}`)
      }
      lines.push("")
    }
  }

  lines.push("**External verification:**")
  lines.push("If you believe this document is incomplete, Read the full QGIS docs for this algorithm:")
  lines.push(`webfetch(url="${docsUrl(algorithm)}", format="markdown")`)
  lines.push(`If the link's anchor is broken, search the page for: Algorithm ID: ${algorithm.id}`)

  return lines.join("\n").trimEnd()
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list_groups", "list_algorithms", "read", "search"]).annotate({
    description:
      "list_groups: list all algorithm groups; list_algorithms: list algorithms in a group; read: read algorithm documentation; search: fuzzy search algorithms by keyword",
  }),
  group: Schema.optional(Schema.String).annotate({
    description: "Algorithm group name, required for list_algorithms",
  }),
  algorithm: Schema.optional(Schema.String).annotate({
    description: "Full algorithm ID (e.g. 'native:xxx', 'qgis:xxx', 'gdal:xxx'), required for read",
  }),
  query: Schema.optional(Schema.String).annotate({ description: "Search keyword, required for search" }),
})

type Metadata = {
  [key: string]: unknown
  /** Always set, so the generic head truncation never runs (docs/TOOLS.md §5.1). */
  truncated: boolean
}

export const QgisDocTool = Tool.define<
  typeof Parameters,
  Metadata,
  GeoQgis.Service | GeoQgis.QgisCatalog.Service | GeoStatus.Service
>(
  "QgisDoc",
  Effect.gen(function* () {
    const qgis = yield* GeoQgis.Service
    const catalog = yield* GeoQgis.QgisCatalog.Service
    const status = yield* GeoStatus.Service

    const run = Effect.fn("QgisDocTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      // Before the prompt, as in the other QGIS tools, so no one approves a lookup the environment cannot serve.
      const deadEnd = yield* GeoTool.qgisLocalDeadEnd(status)
      if (deadEnd) {
        return {
          title: "QGIS algorithm catalog unavailable",
          output: GeoQgis.QgisGuidance.render(deadEnd),
          metadata: { truncated: false, error: true, geoStatus: GeoTool.gateStatus(deadEnd) },
        }
      }

      const target = params.algorithm ?? params.group ?? params.query
      // `doc:` tells this tool from RunQgisAlgorithm under the shared `qgis` key (docs/TOOLS.md §4.3). Replying
      // "always" adds allow rules with exactly the `always` patterns, so `["*"]` would also grant running algorithms.
      yield* ctx.ask({
        permission: "qgis",
        patterns: [target ? `doc:${params.action}:${target}` : `doc:${params.action}`],
        always: ["doc:*"],
        metadata: { action: params.action, ...(target === undefined ? {} : { target }) },
      })

      // Taken before the gate for a refusal, and again after it, since the gate can wait out a new round.
      const entryHeader = yield* GeoTool.qgisHeader(status)

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        return {
          title: "QGIS algorithm catalog unavailable",
          output: [
            entryHeader,
            GeoQgis.QgisGuidance.render(gate.status) ||
              "The QGIS environment settled while this call was checking it — call the tool again.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          metadata: { truncated: false, error: true, geoStatus: GeoTool.gateStatus(gate.status) },
        }
      }
      // The header is part of the answer: which algorithms and parameters exist depends on the QGIS version.
      const header = yield* GeoTool.qgisHeader(status)
      const framed = (body: string) => [header, body].filter(Boolean).join("\n")

      switch (params.action) {
        case "list_groups": {
          const groups = yield* catalog.groups()
          return {
            title: "QGIS algorithm groups",
            output: framed(
              groups.length > 0
                ? groups.map((group, index) => `${index + 1}. ${group.name} (${group.count})`).join("\n")
                : // Right after a passing gate, empty means the catalog was dropped in between, so no cause is named.
                  "The algorithm catalog has nothing to list right now. Call the tool again.",
            ),
            metadata: { truncated: false, count: groups.length },
          }
        }

        case "list_algorithms": {
          if (!params.group) {
            return {
              title: "QGIS algorithms",
              output: framed(
                'Please specify a "group" parameter to list algorithms in.\n' +
                  'Use action="list_groups" to see all available groups.',
              ),
              metadata: { truncated: false },
            }
          }
          const algorithms = yield* catalog.inGroup(params.group)
          if (algorithms.length === 0) {
            const suggestions = yield* catalog.suggest(params.group, "group")
            const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(", ")}?` : ""
            return {
              title: `QGIS algorithms: ${params.group}`,
              output: framed(
                `No algorithms found in group "${params.group}".${hint}\n` +
                  'Use action="list_groups" to see all available groups.',
              ),
              metadata: { truncated: false, group: params.group, count: 0 },
            }
          }
          // The catalog's spelling, not the caller's: `inGroup` matches folded names.
          const canonical = algorithms[0]!.group || GeoQgis.QgisCatalog.UNGROUPED
          return {
            title: `QGIS algorithms: ${canonical}`,
            output: framed(
              algorithms.map((algorithm, index) => `${index + 1}. ${algorithm.id} — ${algorithm.name}`).join("\n"),
            ),
            metadata: { truncated: false, group: canonical, count: algorithms.length },
          }
        }

        case "read": {
          if (!params.algorithm) {
            return {
              title: "QGIS algorithm documentation",
              output: framed(
                'Please specify an "algorithm" parameter (algorithm ID).\n' +
                  'Use action="search" to find an algorithm by keyword.',
              ),
              metadata: { truncated: false },
            }
          }
          const resolution = yield* catalog.resolve(params.algorithm)
          // Ambiguity gets the candidates the lookup declined to choose between, not "not found" and a search.
          if (resolution.kind === "ambiguous") {
            return {
              title: `QGIS algorithm: ${params.algorithm}`,
              output: framed(
                `"${params.algorithm}" names ${resolution.candidates.length} algorithms, so it is not a usable identifier on its own.\n` +
                  `Call again with one of these full IDs: ${resolution.candidates.join(", ")}`,
              ),
              metadata: {
                truncated: false,
                algorithm: params.algorithm,
                ambiguous: true,
                candidates: resolution.candidates,
              },
            }
          }
          if (resolution.kind === "missing") {
            const suggestions = yield* catalog.suggest(params.algorithm, "algorithm")
            const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(", ")}?` : ""
            return {
              title: `QGIS algorithm: ${params.algorithm}`,
              output: framed(
                `Algorithm not found: "${params.algorithm}".${hint}\n` +
                  'Use action="search" with a keyword, or list_groups + list_algorithms to browse.',
              ),
              metadata: { truncated: false, algorithm: params.algorithm },
            }
          }
          const algorithm = resolution.algorithm
          return {
            title: algorithm.id,
            output: framed(formatAlgorithm(algorithm)),
            metadata: { truncated: false, algorithm: algorithm.id, group: algorithm.group },
          }
        }

        case "search": {
          if (!params.query) {
            return {
              title: "QGIS algorithm search",
              output: framed('Please specify a "query" parameter (a keyword to search for).'),
              metadata: { truncated: false },
            }
          }
          // One over the limit, to tell "exactly ten hits" from "more than ten".
          const hits = yield* catalog.search(params.query, SEARCH_LIMIT + 1)
          if (hits.length === 0) {
            return {
              title: `Search: ${params.query}`,
              output: framed(`No algorithms found matching "${params.query}".`),
              metadata: { truncated: false, query: params.query, count: 0 },
            }
          }
          const shown = hits.slice(0, SEARCH_LIMIT)
          const more = hits.length > SEARCH_LIMIT
          const lines = shown.map((algorithm, index) => {
            const description = algorithm.description ? ` — ${algorithm.description.slice(0, 80)}` : ""
            return `${index + 1}. ${algorithm.id} (${algorithm.group || GeoQgis.QgisCatalog.UNGROUPED})${description}`
          })
          if (more) lines.push(`(More than ${SEARCH_LIMIT} algorithms match. Narrow the query to see the rest.)`)
          return {
            title: `Search: ${params.query}`,
            output: framed(lines.join("\n")),
            // `more` goes here too, for a frontend that reads only the fields.
            metadata: { truncated: false, query: params.query, count: shown.length, ...(more ? { more: true } : {}) },
          }
        }

        default: {
          // Unreachable while the schema holds; returned rather than thrown, like every other outcome here.
          const action: string = (params as { action: string }).action
          return {
            title: "Invalid action",
            output: framed(`Unknown action: "${action}".\nValid actions: list_groups, list_algorithms, read, search.`),
            metadata: { truncated: false },
          }
        }
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
