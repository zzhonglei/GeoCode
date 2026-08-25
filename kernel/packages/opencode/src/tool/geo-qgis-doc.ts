import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoStatus } from "@/geo"
import { GeoTool } from "./geo-tool"
import DESCRIPTION from "./geo-qgis-doc.txt"

/* --- GeoCode: QgisDoc, the algorithm catalog's reading face (docs/TOOLS.md §3, GEOKERNEL §4.11).
 *
 * Every action is a query against the in-memory catalog, so nothing is spawned and no output grows with user data —
 * the catalog is a property of the QGIS install (measured on a real 3.44 install: 34 groups in 774 bytes, largest
 * group 4220, largest help text 7218), which is what makes `truncated: false` a statement of fact. Only
 * `search` bounds its answer, by asking the model to narrow rather than dropping the tail (§5.2 there). --- */

const QGIS_PROCESSING_DOCS = "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs"

/** How many search hits to show before asking the model to narrow instead. */
const SEARCH_LIMIT = 10

/** Structural rather than the catalog's Algorithm, so the tripwire can call `docsUrl` with a bare literal. */
type Named = { readonly id: string; readonly name: string; readonly group: string }

/**
 * The deep link into the official QGIS documentation, by the rule archived in GEOKERNEL §4.11: the anchor is the
 * dash-slug of the DISPLAY NAME, because that is what the documentation's own table of contents resolves to. An
 * id-derived anchor has no dashes and is a broken link for every multi-word name.
 */
export function docsUrl(algorithm: Named): string {
  const provider = algorithm.id.startsWith("gdal:")
    ? "gdal"
    : algorithm.id.startsWith("native:") || algorithm.id.startsWith("qgis:")
      ? "qgis"
      : undefined
  if (!provider) return `${QGIS_PROCESSING_DOCS}/index.html`
  // The page slug deletes non-alphanumerics where the anchor below dashes them; not the same rule.
  const page = algorithm.group.toLowerCase().replace(/[^a-z0-9]/g, "")
  // An algorithm declaring no group has no page; without this the URL reads ".../qgis/.html#name", a 404 dressed
  // up as a citation.
  if (!page) return `${QGIS_PROCESSING_DOCS}/index.html`
  const anchor = algorithm.name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${QGIS_PROCESSING_DOCS}/${provider}/${page}.html#${anchor}`
}

/**
 * One algorithm as documentation text. The help text QGIS exports is reproduced VERBATIM (GEOKERNEL §4.11): it is
 * the authoritative description and a shorter but subtly wrong one costs more than the tokens it saves. Only the two
 * facts it does not carry — which parameters are required, which have defaults — are added above it.
 *
 * The structured listing on the other branch is the fallback for the algorithms that export no help text at all.
 */
export function formatAlgorithm(algorithm: GeoQgis.QgisCatalog.Algorithm): string {
  const required = algorithm.parameters.filter((param) => !param.optional)
  const withDefaults = algorithm.parameters.filter((param) => param.defaultValue !== null)
  const lines: string[] = []
  lines.push(`Algorithm: ${algorithm.id}`)
  lines.push(`Name: ${algorithm.name}`)
  // The same fallback groups() lists by, so the group printed here is one list_algorithms answers to; the raw empty
  // string would be an unusable value in front of the model.
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
  /** Always set, so the generic head truncation never runs (docs/TOOLS.md §5). */
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
      /* --- The pattern names the object this call is about, namespaced by action and prefixed `doc:` so a rule can
       * tell this tool from RunQgisAlgorithm, which shares the `qgis` key (docs/TOOLS.md §4.3).
       *
       * `always` is the half that matters: replying "always" writes a rule using EXACTLY these patterns
       * (permission/index.ts), so `["*"]` would turn one approved documentation lookup into a standing grant to run
       * algorithms. --- */
      /* The environment, before the prompt — a user is never asked about an operation the environment cannot run,
       * and a rule with an exception in one of three places is one someone later "fixes" in the wrong direction. */
      const deadEnd = yield* GeoTool.qgisLocalDeadEnd(status)
      if (deadEnd) {
        return {
          title: "QGIS algorithm catalog unavailable",
          output: GeoQgis.QgisGuidance.render(deadEnd),
          metadata: { truncated: false, error: true, geoStatus: GeoTool.gateStatus(deadEnd) },
        }
      }

      const target = params.algorithm ?? params.group ?? params.query
      yield* ctx.ask({
        permission: "qgis",
        patterns: [target ? `doc:${params.action}:${target}` : `doc:${params.action}`],
        always: ["doc:*"],
        metadata: { action: params.action, ...(target === undefined ? {} : { target }) },
      })

      // Taken before the gate so a refusal still carries the environment line, and again after it (§11 环境头快照).
      const entryHeader = yield* GeoTool.qgisHeader(status)

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        // The catalog is only populated behind a passing gate, and the guidance is the kernel's so all three QGIS
        // tools say the same words (GEOKERNEL §8.6).
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
      // Which install these docs describe is part of the answer: algorithm availability and parameter sets move
      // between QGIS versions.
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
                : // Not "this install has no algorithms": the gate passed a moment ago, so an empty catalog means
                  // it was dropped between the two, and naming a cause we cannot see would send the Agent off
                  // diagnosing an install that is fine.
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
          // The group the CATALOG calls it, not the caller's spelling: `inGroup` matches folded (§4.11), so echoing
          // the input would put "VECTOR GEOMETRY" in front of the user as if that were the group's name.
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
          // Ambiguity and absence need opposite advice: "not found" for a name the catalog holds several of sends
          // the model searching when all it has to do is choose. The candidates are the set the lookup declined to
          // pick between, not fuzzy neighbours re-guessed afterwards (GEOKERNEL §4.11).
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
          // One over the limit, to tell "exactly ten hits" from "at least eleven": the bound is presented as advice
          // to narrow the query, which the model can act on where it cannot even see a silent cut (docs/TOOLS.md
          // §5.2).
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
            // `more` rides here too, or a frontend reading only the fields renders "10 results" for a query that
            // has fifty; both channels have to agree (GEOKERNEL §9.1).
            metadata: { truncated: false, query: params.query, count: shown.length, ...(more ? { more: true } : {}) },
          }
        }

        default: {
          // Unreachable while the schema's literal union holds. Returning rather than throwing keeps the promise
          // the whole tool makes: every outcome is an answer the model can act on, never a tool error it can only
          // report (docs/TOOLS.md §3).
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
