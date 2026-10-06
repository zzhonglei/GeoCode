export * as Doc from "./doc.ts"

import { Catalog } from "./catalog.ts"

/** Search hits shown; the total is reported, so a model knows to narrow the query. */
export const SEARCH_LIMIT = 10

/** A release's manual: docs.qgis.org sends a release it has none for to the nearest one, and `latest` to the LTR. */
const manual = (qgis: string) =>
  `https://docs.qgis.org/${/^\d+\.\d+/.exec(qgis)?.[0] ?? "latest"}/en/docs/user_manual/processing_algs`

const RULE = "----------------"

/** `qgis_process help` words its notes in C++, not in anything Python can read, so they are copied from it. */
const NOTES: readonly (readonly [number, string])[] = [
  [1, "This algorithm drops existing primary keys or FID values and regenerates them in output layers."],
  [
    2,
    "This algorithm may drop existing primary keys or FID values and regenerate them in output layers, depending on the input parameters.",
  ],
  [4, "This algorithm uses ellipsoid based measurements and respects the current ellipsoid settings."],
]

/** Distances, areas and volumes are measured in the units of their parent layer's CRS. */
const MEASURES = new Set(["distance", "area", "volume"])

/**
 * The page of the official manual that documents an algorithm. Its anchor slugs the display name, never the id:
 * the id-shaped anchors on those pages are placeholders, so an id-based link breaks for every multi-word name.
 */
export const docsUrl = (algorithm: Catalog.Algorithm, qgis: string) => {
  const provider = algorithm.id.startsWith("gdal:") ? "gdal" : "qgis"
  // The page name deletes what the anchor below turns into dashes.
  const page = algorithm.group.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!page) return `${manual(qgis)}/index.html`
  const anchor = algorithm.name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${manual(qgis)}/${provider}/${page}.html#${anchor}`
}

/**
 * Which QGIS answered, on every answer with content: algorithms and their parameters differ between releases. A
 * misused action gets only what to do instead.
 */
const framed = (catalog: Catalog.Catalog, body: string) => `QGIS ${catalog.qgis}\n\n${body}`

/** An algorithm in a list: its ID, name and summary. */
export const line = (algorithm: Catalog.Algorithm, withGroup = false) => {
  const group = withGroup ? ` (${Catalog.groupOf(algorithm)})` : ""
  const description = algorithm.description ? `: ${algorithm.description}` : ""
  return `${algorithm.id} — ${algorithm.name}${group}${description}`
}

export const groups = (catalog: Catalog.Catalog) => {
  const all = Catalog.groups(catalog)
  const listed = all.map((group) => `${group.name} (${group.count})`).join("\n")
  return framed(catalog, `${all.length} groups, ${catalog.algorithms.length} algorithms:\n${listed}`)
}

export const algorithms = (catalog: Catalog.Catalog, group: string) => {
  const found = Catalog.inGroup(catalog, group)
  if (found.length === 0) {
    const listed = Catalog.groups(catalog)
      .map((entry) => entry.name)
      .join("\n")
    return `There is no group "${group}". The groups are:\n${listed}`
  }
  const name = Catalog.groupOf(found[0]!)
  return framed(
    catalog,
    `${name}, ${found.length} algorithms:\n${found.map((algorithm) => line(algorithm)).join("\n")}`,
  )
}

export const search = (catalog: Catalog.Catalog, query: string) => {
  const hits = Catalog.search(catalog, query)
  if (hits.length === 0) return `No algorithm matches "${query}". Search with English keywords.`
  const shown = hits.slice(0, SEARCH_LIMIT)
  const heading =
    hits.length > SEARCH_LIMIT
      ? `${hits.length} algorithms match "${query}"; the first ${SEARCH_LIMIT}, best first. Add words to narrow the search:`
      : `${hits.length} ${hits.length === 1 ? "algorithm matches" : "algorithms match"} "${query}":`
  return framed(catalog, `${heading}\n${shown.map((algorithm) => line(algorithm, true)).join("\n")}`)
}

export const help = (catalog: Catalog.Catalog, text: string) => {
  const resolution = Catalog.resolve(catalog, text)
  switch (resolution.kind) {
    case "found":
      return framed(catalog, document(resolution.algorithm, catalog.qgis))
    case "ambiguous":
      return (
        `"${text}" names several algorithms. Call again with one of these IDs:\n` +
        resolution.candidates.map((algorithm) => line(algorithm, true)).join("\n")
      )
    // Needs QGIS's interface or an open project; why is nothing GeoAgent can act on.
    case "excluded":
      return `${resolution.id} is not available.`
    case "missing": {
      const similar = resolution.suggestions.length
        ? `\nSimilar IDs:\n${resolution.suggestions.map((algorithm) => line(algorithm, true)).join("\n")}`
        : ""
      return `There is no algorithm "${text}".${similar}\nUse action "search" to find algorithms.`
    }
  }
}

export type Action = "groups" | "algorithms" | "help" | "search"

export interface Request {
  readonly action: Action
  readonly group?: string
  readonly algorithm?: string
  readonly query?: string
}

/** What each action needs and how to describe it to a caller that left it out. */
const NEEDS = {
  algorithms: ["group", 'a group name as action "groups" lists them'],
  help: ["algorithm", 'a full algorithm ID such as "native:buffer"'],
  search: ["query", "English keywords"],
} as const

export const answer = (catalog: Catalog.Catalog, request: Request) => {
  if (request.action === "groups") return groups(catalog)
  const [field, described] = NEEDS[request.action]
  const value = request[field]
  if (!value?.trim()) return `Action "${request.action}" needs "${field}", ${described}.`
  if (request.action === "algorithms") return algorithms(catalog, value)
  if (request.action === "help") return help(catalog, value)
  return search(catalog, value)
}

/** `qgis_process help`, with what a call needs and its text leaves out: multiple values, parent layers, advanced. */
function document(algorithm: Catalog.Algorithm, qgis: string) {
  const sections = [`${algorithm.name} (${algorithm.id})`]
  const description = [algorithm.description, algorithm.help].filter(Boolean).join("\n")
  if (description) sections.push(section("Description", description))
  const notes = NOTES.filter(([flag]) => algorithm.notes & flag).map(([, note]) => ` - ${note}`)
  if (notes.length) sections.push(section("Notes", `\n${notes.join("\n")}`))
  sections.push(section("Arguments", `\n${algorithm.parameters.map(argument).join("\n")}`))
  const outputs = algorithm.outputs.map((output) => `${output.name}: <${output.type}>\n\t${output.description}`)
  if (outputs.length) sections.push(section("Outputs", `\n${outputs.join("\n")}`))
  sections.push(
    `If anything here is unclear or incomplete, read this algorithm's section of the official QGIS documentation:\n` +
      `webfetch(url="${docsUrl(algorithm, qgis)}")`,
  )
  return sections.join("\n\n")
}

function section(title: string, body: string) {
  return `${RULE}\n${title}\n${RULE}\n${body}`
}

function argument(parameter: Catalog.Parameter) {
  const marks = [parameter.optional && " (optional)", parameter.advanced && " (advanced)"].filter(Boolean).join("")
  const lines = [`${parameter.name}: ${parameter.description}${marks}`]
  const fallback = defaultValue(parameter.default)
  if (fallback !== undefined) lines.push(`\tDefault value:\t${fallback}`)
  if (parameter.help) lines.push(`\t${parameter.help}`)
  lines.push(`\tArgument type:\t${argumentType(parameter)}`)
  // An enum of static strings refuses numbers, though qgis_process help numbers its options and lists numbers as acceptable.
  const option = (value: string, index: number) => (parameter.static ? `\t\t- ${value}` : `\t\t- ${index}: ${value}`)
  if (parameter.options?.length) lines.push("\tAvailable values:", ...parameter.options.map(option))
  // qgis_process turns these prefixes into data-defined values itself; a call through Processing does not.
  const accepted = parameter.static ? [] : parameter.accepted.filter((value) => !/^(field|expression):/.test(value))
  if (accepted.length) lines.push("\tAcceptable values:", ...accepted.map((value) => `\t\t- ${value}`))
  return lines.join("\n")
}

function argumentType(parameter: Catalog.Parameter) {
  const parent = parameter.parent
  const kind = !parent
    ? parameter.type
    : parameter.type === "field" || parameter.type === "band"
      ? `${parameter.type} of ${parent}`
      : parameter.type === "expression"
        ? `expression on ${parent}`
        : MEASURES.has(parameter.type)
          ? `${parameter.type} in the units of ${parent}'s CRS`
          : `${parameter.type} of ${parent}`
  return parameter.multiple ? `${kind}, multiple values allowed` : kind
}

function defaultValue(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}
