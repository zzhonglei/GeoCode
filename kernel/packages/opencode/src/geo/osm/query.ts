export * as OsmQuery from "./query"

/* --- GeoCode: building Overpass QL (docs/GEOKERNEL.md §6.5). Pure functions, no network, so the rules below are
 * pinned by test/geo/osm-query.test.ts rather than against a live service. --- */

export type OsmType = "relation" | "way" | "node"

const TYPE_BY_PREFIX: Record<string, OsmType> = { R: "relation", W: "way", N: "node" }

export interface OsmRef {
  readonly type: OsmType
  readonly id: number
}

/** Parse `R10717504` / `W123` / `N456`, prefix case-insensitive. */
export function parseRef(spec: string): OsmRef {
  const text = spec.trim()
  const type = TYPE_BY_PREFIX[text[0]?.toUpperCase() ?? ""]
  const id = Number(text.slice(1))
  if (!type || !Number.isInteger(id) || id <= 0) {
    throw new Error(`"${spec}" is not an OSM id: expected R, W or N followed by a number, for example R10717504`)
  }
  return { type, id }
}

export function formatRef(ref: { readonly type: string; readonly id: number }): string {
  return `${ref.type[0]!.toUpperCase()}${ref.id}`
}

/**
 * Relations only: the public instances no longer materialize way-derived area ids, so returning one would build a
 * filter that matches nothing and a download that reports success over an empty set (§6.5 已知限制).
 */
export function areaId(ref: OsmRef): number {
  if (ref.type === "relation") return 3_600_000_000 + ref.id
  throw new Error(
    `Overpass areas only exist for relations, and ${formatRef(ref)} is a ${ref.type}. ` +
      `Download the object first and pass the file as "file:<path>", or use a bounding box.`,
  )
}

/** Escape for a double-quoted QL literal. */
export function escapeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Official names carry metacharacters — a branch written `成都(高新)店` — and unescaped they match something else. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type TypeSelector = "node" | "way" | "relation" | "nwr"

export function normalizeTypes(types: string | undefined): TypeSelector[] {
  if (!types || types.trim() === "" || types.trim() === "nwr") return ["nwr"]
  const parts = types
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  for (const part of parts) {
    if (part !== "node" && part !== "way" && part !== "relation") {
      throw new Error(`"${types}" is not a type list: use node, way, relation separated by commas, or "nwr" for all`)
    }
  }
  return [...new Set(parts)] as TypeSelector[]
}

/**
 * `amenity=hospital` → `["amenity"="hospital"]`, `healthcare` → `["healthcare"]`, `highway~primary|trunk` →
 * `["highway"~"primary|trunk"]`, and anything already bracketed passes through untouched.
 */
export function tagClause(tag: string): string {
  const text = tag.trim()
  if (text === "") throw new Error("a tag filter cannot be empty")
  if (text.startsWith("[")) return text
  const regex = /^([^=~]+)~(.+)$/.exec(text)
  if (regex) return `["${escapeLiteral(regex[1]!.trim())}"~"${escapeLiteral(regex[2]!.trim())}"]`
  const equals = /^([^=~]+)=(.+)$/.exec(text)
  if (equals) return `["${escapeLiteral(equals[1]!.trim())}"="${escapeLiteral(equals[2]!.trim())}"]`
  return `["${escapeLiteral(text)}"]`
}

/** The key out of any of those forms — what the field policy keeps by. */
export function tagKey(tag: string): string {
  const text = tag.trim()
  if (text.startsWith("[")) return /^\[\s*"([^"]+)"/.exec(text)?.[1] ?? text
  return text.split(/[=~]/)[0]!.trim()
}

export interface Spatial {
  /** Statements to put before the union, e.g. `area(3610717504)->.a;`. */
  readonly prelude: string
  /** One clause per entry: a study area is often several parts, and querying only the largest loses the rest. */
  readonly filters: readonly string[]
}

function union(spatial: Spatial, tags: readonly string[], types: readonly TypeSelector[]): string[] {
  const clauses: string[] = []
  for (const filter of spatial.filters) {
    for (const type of types) {
      for (const tag of tags) clauses.push(`  ${type}${tagClause(tag)}${filter};`)
    }
  }
  return clauses
}

function assemble(lines: readonly string[]): string {
  return lines.filter((line) => line !== "").join("\n")
}

export interface UnionInput {
  readonly spatial: Spatial
  readonly tags: readonly string[]
  readonly types: readonly TypeSelector[]
  readonly timeoutSec: number
}

/** Download: every matching element with its geometry inlined. */
export function download(input: UnionInput): string {
  return assemble([
    `[out:json][timeout:${input.timeoutSec}];`,
    input.spatial.prelude,
    `(`,
    ...union(input.spatial, input.tags, input.types),
    `);`,
    `out geom;`,
  ])
}

/** Reconnaissance: how many, without moving any geometry. */
export function count(input: UnionInput): string {
  return assemble([
    `[out:json][timeout:${input.timeoutSec}];`,
    input.spatial.prelude,
    `(`,
    ...union(input.spatial, input.tags, input.types),
    `);`,
    `out count;`,
  ])
}

/** Reconnaissance: which values a key actually takes here, tags only. */
export function tagStats(input: {
  readonly spatial: Spatial
  readonly key: string
  readonly types: readonly TypeSelector[]
  readonly timeoutSec: number
  readonly sampleLimit: number
}): string {
  return assemble([
    `[out:json][timeout:${input.timeoutSec}];`,
    input.spatial.prelude,
    `(`,
    ...union(input.spatial, [input.key], input.types),
    `);`,
    `out tags ${input.sampleLimit};`,
  ])
}

/** Per-type caps for a name search. */
export interface Caps {
  readonly relation: number
  readonly way: number
  readonly node: number
}

const DEFAULT_CAPS: Caps = { relation: 15, way: 15, node: 10 }

/**
 * Unanchored, since official names carry campus and branch suffixes nobody types. Case folding costs server-side
 * time and CJK has no case, so it is added only for a pattern with latin letters; each type gets its own cap and
 * relations are asked for first, because a shared cap is spent on nodes before a relation appears (§6.5 类型配额).
 */
export function nameSearch(input: {
  readonly query: string
  readonly category?: string
  readonly timeoutSec: number
  readonly caps?: Caps
  /** Set when `query` is a regex we built ourselves, e.g. an alternation of names. */
  readonly rawRegex?: boolean
}): string {
  const caps = input.caps ?? DEFAULT_CAPS
  const name = escapeLiteral(input.rawRegex ? input.query : escapeRegex(input.query))
  const category = input.category ? tagClause(input.category) : ""
  const fold = /[a-zA-Z]/.test(name) ? ",i" : ""
  return assemble([
    `[out:json][timeout:${input.timeoutSec}];`,
    `rel["name"~"${name}"${fold}]${category};`,
    `out tags center ${caps.relation};`,
    `way["name"~"${name}"${fold}]${category};`,
    `out tags center ${caps.way};`,
    `node["name"~"${name}"${fold}]${category};`,
    `out tags center ${caps.node};`,
  ])
}

/** A campus is a site relation whose members are named differently, so a name search reaches the parent and stops. */
export function siteExpansion(input: { readonly query: string; readonly timeoutSec: number }): string {
  const name = escapeLiteral(escapeRegex(input.query))
  return assemble([
    `[out:json][timeout:${input.timeoutSec}];`,
    `rel["name"~"${name}"]["type"="site"]->.s;`,
    `(`,
    `  rel(r.s);`,
    `  way(r.s);`,
    `);`,
    `out tags center 20;`,
  ])
}

/**
 * One query for the whole set, with `out geom` rather than stitching sibling elements afterwards: the cross-element
 * form silently produces partial boundaries on large relations, and a partial boundary looks like a boundary (§6.8).
 */
export function objects(input: { readonly refs: readonly OsmRef[]; readonly timeoutSec: number }): string {
  const groups = new Map<OsmType, number[]>()
  for (const ref of input.refs) {
    const list = groups.get(ref.type) ?? []
    list.push(ref.id)
    groups.set(ref.type, list)
  }
  const clauses = [...groups].map(([type, ids]) => `  ${type === "relation" ? "rel" : type}(id:${ids.join(",")});`)
  return assemble([`[out:json][timeout:${input.timeoutSec}];`, `(`, ...clauses, `);`, `out geom;`])
}
