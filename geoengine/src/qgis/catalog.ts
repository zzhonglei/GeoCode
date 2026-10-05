export * as Catalog from "./catalog.ts"

import { Schema } from "effect"

export const Parameter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  type: Schema.String,
  optional: Schema.Boolean,
  advanced: Schema.Boolean,
  destination: Schema.Boolean,
  help: Schema.String,
  default: Schema.Unknown,
  accepted: Schema.Array(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  /** An enum that takes the option itself rather than its number. */
  static: Schema.optionalKey(Schema.Boolean),
  multiple: Schema.optionalKey(Schema.Boolean),
  parent: Schema.optionalKey(Schema.String),
})
export type Parameter = typeof Parameter.Type

export const Algorithm = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  group: Schema.String,
  description: Schema.String,
  help: Schema.String,
  tags: Schema.Array(Schema.String),
  /** QGIS's documentation flags, which `qgis_process help` prints as notes. */
  notes: Schema.Number,
  parameters: Schema.Array(Parameter),
  outputs: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, description: Schema.String })),
})
export type Algorithm = typeof Algorithm.Type

/** What the catalog script reports. */
export const Report = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    qgis: Schema.String,
    algorithms: Schema.Array(Algorithm),
    /** Left out because they need QGIS's interface; named so a request for one is answered, not reported missing. */
    excluded: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type Catalog = Extract<typeof Report.Type, { ok: true }>

/** The group shown for an algorithm that declares none, so every listed group can be listed. */
export const UNGROUPED = "Ungrouped"

export const groupOf = (algorithm: Algorithm) => algorithm.group || UNGROUPED

/** Models respell names rather than misspell them, so case, spaces and punctuation never decide a lookup. */
export const fold = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

const shortId = (id: string) => id.slice(id.indexOf(":") + 1)

export interface Group {
  readonly name: string
  readonly count: number
}

export const groups = (catalog: Catalog): Group[] => {
  const counts = new Map<string, number>()
  for (const algorithm of catalog.algorithms) counts.set(groupOf(algorithm), (counts.get(groupOf(algorithm)) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))
}

export const inGroup = (catalog: Catalog, group: string): Algorithm[] => {
  const wanted = fold(group)
  if (!wanted) return []
  return catalog.algorithms.filter((algorithm) => fold(groupOf(algorithm)) === wanted).sort(byId)
}

export type Resolution =
  | { readonly kind: "found"; readonly algorithm: Algorithm }
  /** Several algorithms answer to the name; they are returned rather than one picked. */
  | { readonly kind: "ambiguous"; readonly candidates: readonly Algorithm[] }
  | { readonly kind: "excluded"; readonly id: string; readonly name: string }
  | { readonly kind: "missing"; readonly suggestions: readonly Algorithm[] }

/**
 * From strict to loose: the exact id, then the id with or without its provider, then the display name. Every step
 * below the exact id tolerates respelling but never guesses: two algorithms behind one key make the answer ambiguous,
 * as `slope` names both `gdal:slope` and `native:slope`, whose parameters differ.
 */
export const resolve = (catalog: Catalog, text: string): Resolution => {
  const exact = catalog.algorithms.find((algorithm) => algorithm.id === text)
  if (exact) return { kind: "found", algorithm: exact }
  const wanted = fold(text)
  if (wanted) {
    for (const key of [
      (algorithm: Algorithm) => [fold(algorithm.id), fold(shortId(algorithm.id))],
      (algorithm: Algorithm) => [fold(algorithm.name)],
    ]) {
      const hits = catalog.algorithms.filter((algorithm) => key(algorithm).includes(wanted)).sort(byId)
      if (hits.length === 1) return { kind: "found", algorithm: hits[0]! }
      if (hits.length > 1) return { kind: "ambiguous", candidates: hits }
    }
    // Without the provider, since releases move algorithms between them (`qgis:selectbyexpression` became native).
    const unprovided = fold(shortId(text))
    const left = catalog.excluded.find((algorithm) => fold(shortId(algorithm.id)) === unprovided)
    if (left) return { kind: "excluded", id: left.id, name: left.name }
  }
  return { kind: "missing", suggestions: similar(catalog, text) }
}

/** How well a word matches, best first: the id or name itself, part of them, a QGIS tag, the descriptions. */
const tier = (algorithm: Algorithm, word: string) => {
  const name = fold(algorithm.name)
  const ids = [fold(algorithm.id), fold(shortId(algorithm.id))]
  if (name === word || ids.includes(word)) return 0
  if (name.includes(word) || ids.some((id) => id.includes(word))) return 1
  if (algorithm.tags.some((tag) => fold(tag).includes(word))) return 2
  if (fold(algorithm.description).includes(word)) return 3
  if (fold(algorithm.help).includes(word)) return 4
  return undefined
}

/** Every algorithm matching every word of the query, best first. */
export const search = (catalog: Catalog, query: string): Algorithm[] => {
  const words = query.split(/\s+/).map(fold).filter(Boolean)
  if (words.length === 0) return []
  const scored = catalog.algorithms.flatMap((algorithm) => {
    const tiers = words.map((word) => tier(algorithm, word))
    if (tiers.some((value) => value === undefined)) return []
    return [{ algorithm, score: Math.max(...(tiers as number[])) }]
  })
  return scored.sort((a, b) => a.score - b.score || byId(a.algorithm, b.algorithm)).map(({ algorithm }) => algorithm)
}

const SUGGESTIONS = 5

/** The algorithms whose id or name is closest to some text that matched nothing, for a "did you mean". */
export const similar = (catalog: Catalog, text: string): Algorithm[] => {
  const wanted = fold(text)
  if (!wanted) return []
  // An ID from another release may name another provider; the rest of it still says which algorithm was meant.
  const unprovided = fold(shortId(text))
  const limit = Math.max(2, Math.floor(unprovided.length / 3))
  return catalog.algorithms
    .map((algorithm) => ({
      algorithm,
      distance: Math.min(
        ...[fold(shortId(algorithm.id)), fold(algorithm.name)].flatMap((key) => [
          editDistance(key, wanted),
          editDistance(key, unprovided),
        ]),
      ),
    }))
    .filter(({ distance }) => distance <= limit)
    .sort((a, b) => a.distance - b.distance || byId(a.algorithm, b.algorithm))
    .slice(0, SUGGESTIONS)
    .map(({ algorithm }) => algorithm)
}

function byId(a: Algorithm, b: Algorithm) {
  return a.id.localeCompare(b.id)
}

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}
