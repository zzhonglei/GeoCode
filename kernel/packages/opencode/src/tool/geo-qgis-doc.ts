import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoStatus } from "@/geo"
import { GeoTool } from "./geo-tool"
import DESCRIPTION from "./geo-qgis-doc.txt"

/* --- GeoCode: QgisDoc, the algorithm catalog's reading face
 * (docs/TOOLS.md §3, GEOKERNEL §4.11).
 *
 * The catalog is built by the QGIS lifecycle and lives in memory; this tool is
 * the model-facing half of it — browse groups, list a group, read one
 * algorithm, search by keyword. It spawns nothing: every action is a query
 * against what is already held, which is why it is the cheapest of the three
 * QGIS tools and the one the Agent should reach for before running anything.
 *
 * Output cannot grow with user data — the catalog is a property of the QGIS
 * install, not of the scene being processed (measured on a real 3.44 install:
 * 34 groups, 774 bytes; largest group 4220 bytes; largest help text 7218
 * bytes). So `truncated: false` is a statement of fact, not a promise we have
 * to keep by cutting something. Only `search` bounds its answer, and it bounds
 * it by asking the model to narrow the query rather than by silently dropping
 * the tail (docs/TOOLS.md §5.2). --- */

const QGIS_PROCESSING_DOCS = "https://docs.qgis.org/latest/en/docs/user_manual/processing_algs"

/** How many search hits to show before asking the model to narrow instead. */
const SEARCH_LIMIT = 10

/** The shape both the catalog's Algorithm and the doc-link derivation need. */
type Named = { readonly id: string; readonly name: string; readonly group: string }

/**
 * The deep link into the official QGIS documentation, derived by the rule
 * archived in GEOKERNEL §4.11 — archived precisely because it was calibrated
 * against the real documentation site after the old version got it wrong, and
 * rewriting it from intuition reproduces the bug.
 *
 * The anchor comes from the DISPLAY NAME, not the algorithm id: the Sphinx
 * section id the documentation's own table of contents resolves to is the
 * dash-slug of the display name. An id-derived anchor ("reclassifybytable")
 * has no dashes and is therefore a broken link for every multi-word name;
 * single-word ones like "buffer" matched only by coincidence.
 *
 * Exported for the tripwire: pure, so the gate can check it on a machine with
 * no QGIS installed.
 */
export function docsUrl(algorithm: Named): string {
  const provider = algorithm.id.startsWith("gdal:")
    ? "gdal"
    : algorithm.id.startsWith("native:") || algorithm.id.startsWith("qgis:")
      ? "qgis"
      : undefined
  if (!provider) return `${QGIS_PROCESSING_DOCS}/index.html`
  // Page name: the group lowercased with every non-alphanumeric character
  // DELETED (no dashes). Anchor: the display name lowercased, `&` dropped,
  // runs of non-alphanumerics collapsed to a single dash, edges trimmed.
  const page = algorithm.group.toLowerCase().replace(/[^a-z0-9]/g, "")
  // An algorithm declaring no group has no page to link to; the index is the
  // honest destination. Without this the URL reads ".../qgis/.html#name",
  // which is a 404 dressed up as a citation.
  if (!page) return `${QGIS_PROCESSING_DOCS}/index.html`
  const anchor = algorithm.name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${QGIS_PROCESSING_DOCS}/${provider}/${page}.html#${anchor}`
}

/**
 * One algorithm as documentation text.
 *
 * The help text QGIS exports is reproduced VERBATIM — never trimmed, never
 * rewritten (GEOKERNEL §4.11). It is the authoritative description maintained
 * by the QGIS project, it already covers the description, every parameter with
 * its accepted data types, enum values and outputs, and a doc that is shorter
 * but subtly wrong costs far more than the tokens it saves. Re-emitting our
 * own structured rendering of the same facts alongside it was how the old
 * version ended up showing the Agent every parameter twice.
 *
 * Two facts the help text does not carry are added above it as compact lookup
 * blocks: which parameters are required, and which have defaults.
 *
 * Fallback: a handful of algorithms export no help text at all, and for those
 * the structured listing is all there is — emitting it beats an empty doc.
 *
 * Exported for the tripwire (pure).
 */
export function formatAlgorithm(algorithm: GeoQgis.QgisCatalog.Algorithm): string {
  const required = algorithm.parameters.filter((param) => !param.optional)
  const withDefaults = algorithm.parameters.filter((param) => param.defaultValue !== null)
  const lines: string[] = []
  lines.push(`Algorithm: ${algorithm.id}`)
  lines.push(`Name: ${algorithm.name}`)
  // The same name groups() lists it under, so the group printed here is a
  // group list_algorithms answers to. Printing the raw empty string would put
  // an unusable value in front of the model.
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
  /** Always set: see the file header — this tool's output has no data-scaled
   * dimension, so the generic head-truncation must never run (docs/TOOLS.md §5). */
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
      // The pattern dimension names the object being operated on (docs/TOOLS.md
      // §4.3) — the algorithm, group or query this call is about, namespaced by
      // the action so a rule about one action cannot match another by accident.
      const target = params.algorithm ?? params.group ?? params.query
      yield* ctx.ask({
        permission: "geo_qgis_doc",
        patterns: [target ? `${params.action}:${target}` : params.action],
        always: ["*"],
        metadata: { action: params.action, ...(target === undefined ? {} : { target }) },
      })

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        // The catalog is only populated behind a passing gate, so a shut gate
        // is the honest answer here too — and the guidance is the kernel's, so
        // all three QGIS tools say the same words (GEOKERNEL §8.6).
        return {
          title: "QGIS algorithm catalog unavailable",
          output:
            GeoQgis.QgisGuidance.render(gate.status) ||
            "The QGIS environment settled while this call was checking it — call the tool again.",
          metadata: { truncated: false, error: true, geoStatus: gate.status.status },
        }
      }
      // Which install these docs describe is part of the answer: algorithm
      // availability and parameter sets move between QGIS versions, so the
      // header rides on documentation for the same reason it rides on results.
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
                : // Deliberately not "this install has no algorithms": the gate
                  // passed a moment ago, so an empty catalog here means it was
                  // dropped between the two — a config change rebuilding it —
                  // and naming a cause we cannot see would send the Agent off
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
          // Report the group the CATALOG calls it, not the spelling the caller
          // happened to use: lookup is now tolerant of case and separators, so
          // echoing the input would put "VECTOR GEOMETRY" in front of the user
          // as if that were the group's name.
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
          // Ambiguity and absence need opposite advice, so they must not read
          // the same. "Not found" for a name the catalog holds four of is
          // simply false, and it sends the model off searching when all it has
          // to do is choose. The candidates come from the resolution itself:
          // they are the set the lookup declined to pick between, not fuzzy
          // neighbours re-guessed afterwards (GEOKERNEL §4.11).
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
          // One over the limit, to tell "exactly ten hits" from "at least
          // eleven": the bound is presented as advice to narrow the query, not
          // as a silent cut — the model can act on the first and cannot even
          // see the second (docs/TOOLS.md §5.2).
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
            // `more` rides in metadata too, or a frontend reading only the
            // fields would render "10 results" for a query that has fifty —
            // the prose channel says so and the structured one has to agree
            // (the double-channel contract, GEOKERNEL §9.1).
            metadata: { truncated: false, query: params.query, count: shown.length, ...(more ? { more: true } : {}) },
          }
        }

        default: {
          // Unreachable while the schema's literal union holds. Returning
          // rather than throwing keeps the promise the whole tool makes: every
          // outcome is a documentation answer the model can act on, never a
          // tool error it can only report (docs/TOOLS.md §3).
          const action: string = (params as { action: string }).action
          return {
            title: "Invalid action",
            output: framed(
              `Unknown action: "${action}".\nValid actions: list_groups, list_algorithms, read, search.`,
            ),
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
