export * as OsmConvert from "./convert"

import osm2geojson from "osm2geojson-lite"
import { OsmQuery } from "./query"

/* --- GeoCode: OSM elements into features (docs/GEOKERNEL.md §6.6).
 *
 * The assembly itself — filling coordinates back into ways, stitching ways
 * into closed rings, deciding which ring is a hole — belongs to the library.
 * What lives here is everything around it: which feature is the one that was
 * asked for, what the field set is, and the checks that stop a partial
 * assembly from being handed over as a whole one. --- */

/** Keys that classify a feature, in the order a category is derived from them. */
const CLASS_KEYS = [
  "amenity",
  "boundary",
  "natural",
  "leisure",
  "landuse",
  "highway",
  "building",
  "railway",
  "shop",
  "tourism",
  "office",
  "craft",
  "waterway",
  "place",
  "public_transport",
] as const

/** Always present, whatever the field policy says. */
export const CORE_FIELDS = ["osm_id", "osm_type", "name", "category"] as const

/** Consumed by a core column, so never counted as dropped. */
const CORE_TAG_KEYS = new Set(["name"])

/**
 * Metadata the library mixes into properties alongside the real tags.
 *
 * `id` and `bounds` come from the element and the query, not from the map —
 * letting them into the field set would present them as tags that could be
 * filtered on (§6.6 一处细节).
 */
const INTERNAL_PROPERTY_KEYS = new Set(["id", "bounds"])

export interface Feature {
  readonly type: "Feature"
  readonly properties: Record<string, unknown>
  readonly geometry: any
}

export interface FieldPolicy {
  readonly keep: ReadonlySet<string>
  /** Every tag preserved, compactly, in one column. */
  readonly keepAll: boolean
}

/**
 * What to keep: the keys the download was queried by, plus anything the caller
 * named. `*` switches to lossless mode instead.
 *
 * A lean set by default because the alternative is a table nobody can read —
 * OSM tags are freeform, and a busy area contributes hundreds of distinct
 * keys. Everything dropped is COUNTED and reported, so the caller can see what
 * it did not get and ask again for exactly that (§6.6 字段契约).
 */
export function fieldPolicy(queryTags: readonly string[], fields?: readonly string[]): FieldPolicy {
  const keep = new Set<string>()
  for (const tag of queryTags) {
    const key = OsmQuery.tagKey(tag)
    if (key) keep.add(key)
  }
  let keepAll = false
  for (const field of fields ?? []) {
    const name = field.trim()
    if (name === "*") {
      keepAll = true
      continue
    }
    if (name) keep.add(name)
  }
  return { keep, keepAll }
}

function deriveCategory(tags: Record<string, string>): { category?: string; key?: string } {
  for (const key of CLASS_KEYS) {
    if (key in tags) return { category: `${key}=${tags[key]}`, key }
  }
  return {}
}

function parseFeatureId(id: unknown): OsmQuery.OsmRef | undefined {
  if (typeof id !== "string") return undefined
  const match = /^(node|way|relation)\/(\d+)$/.exec(id)
  if (!match) return undefined
  return { type: match[1] as OsmQuery.OsmType, id: Number(match[2]) }
}

function rawTags(properties: unknown): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const [key, value] of Object.entries((properties as Record<string, unknown>) ?? {})) {
    if (INTERNAL_PROPERTY_KEYS.has(key)) continue
    if (value === null || value === undefined || value === "") continue
    if (typeof value === "object") continue
    tags[key] = String(value)
  }
  return tags
}

export function buildProperties(
  type: OsmQuery.OsmType,
  id: number,
  tags: Record<string, string>,
  policy: FieldPolicy,
): { properties: Record<string, unknown>; dropped: string[] } {
  const derived = deriveCategory(tags)
  const properties: Record<string, unknown> = {
    osm_id: id,
    osm_type: type,
    name: tags.name ?? null,
    // One "key=value" string rather than a key column and a value column: a
    // bare `type` column would collide with GeoJSON's own, and the pair is
    // only ever read together (§6.6).
    category: derived.category ?? null,
  }
  const dropped: string[] = []
  for (const key of Object.keys(tags)) {
    if (CORE_TAG_KEYS.has(key)) continue
    if (policy.keep.has(key)) {
      properties[key] = tags[key]
      continue
    }
    if (key === derived.key) continue // already visible inside `category`
    if (!policy.keepAll) dropped.push(key)
  }
  if (policy.keepAll) properties.osm_tags = JSON.stringify(tags)
  return { properties, dropped }
}

export interface Converted {
  readonly features: Feature[]
  /** Elements that matched but could not be assembled — reported, never silent. */
  readonly unassembled: string[]
  /** Dropped tag keys with counts, so the caller can ask again for what it needs. */
  readonly droppedFields: Map<string, number>
}

function tally(target: Map<string, number>, keys: readonly string[]) {
  for (const key of keys) target.set(key, (target.get(key) ?? 0) + 1)
}

/**
 * Convert a result set ELEMENT BY ELEMENT.
 *
 * Each element from `out geom` carries its own geometry inline, so converting
 * it alone is enough — and isolation is the point. Handed the whole set at
 * once, the library lets elements consume one another: a relation absorbs its
 * member ways even when those are tagged in their own right, and a relation
 * that fails to assemble takes its members down with it. That is a SILENT
 * loss — the features simply are not in the output (§6.6 逐元素隔离转换).
 */
export function convertElements(raw: unknown, policy: FieldPolicy): Converted {
  const elements: any[] = (raw as any)?.elements ?? []
  const features: Feature[] = []
  const unassembled: string[] = []
  const droppedFields = new Map<string, number>()

  for (const element of elements) {
    if (!element || typeof element.id !== "number") continue
    if (!element.tags || Object.keys(element.tags).length === 0) continue
    if (element.type !== "node" && element.type !== "way" && element.type !== "relation") continue

    const collection: any = osm2geojson(
      { elements: [element] },
      { completeFeature: true, renderTagged: true, excludeWay: true },
    )
    const target = (collection.features ?? []).find((feature: any) => {
      const ref = parseFeatureId(feature.id ?? feature.properties?.id)
      return ref && ref.type === element.type && ref.id === element.id && feature.geometry
    })
    if (!target) {
      unassembled.push(OsmQuery.formatRef(element))
      continue
    }
    const built = buildProperties(element.type, element.id, rawTags(target.properties), policy)
    tally(droppedFields, built.dropped)
    features.push({ type: "Feature", properties: built.properties, geometry: target.geometry })
  }

  return { features, unassembled, droppedFields }
}

/**
 * Convert a whole batch at once, and pick one object out of it.
 *
 * ONLY safe when a single object is wanted, for exactly the reason above: in a
 * batch the elements interfere. Used for the classic full-object format, where
 * member geometry lives in sibling elements and one-at-a-time is not possible.
 */
export function convertBatch(
  raw: unknown,
  policy: FieldPolicy,
): { features: Feature[]; droppedFields: Map<string, number> } {
  const collection: any = osm2geojson(raw as any, { completeFeature: true, renderTagged: true, excludeWay: true })
  const features: Feature[] = []
  const droppedFields = new Map<string, number>()
  for (const feature of collection.features ?? []) {
    if (!feature.geometry) continue
    const ref = parseFeatureId(feature.id ?? feature.properties?.id)
    if (!ref) continue
    const built = buildProperties(ref.type, ref.id, rawTags(feature.properties), policy)
    tally(droppedFields, built.dropped)
    features.push({ type: "Feature", properties: built.properties, geometry: feature.geometry })
  }
  return { features, droppedFields }
}

/** The feature matching a reference, out of whatever a conversion produced. */
export function pick(features: readonly Feature[], ref: OsmQuery.OsmRef): Feature | undefined {
  return features.find((feature) => feature.properties.osm_type === ref.type && feature.properties.osm_id === ref.id)
}

export function countVertices(geometry: any): number {
  const walk = (coordinates: any): number => {
    if (typeof coordinates?.[0] === "number") return 1
    if (!Array.isArray(coordinates)) return 0
    return coordinates.reduce((sum: number, child: any) => sum + walk(child), 0)
  }
  return walk(geometry?.coordinates)
}

/**
 * Whether an assembled geometry plausibly used the nodes it was given.
 *
 * The failure this guards against is specific and was seen in production: a
 * large boundary assembles from a fraction of its nodes and comes back looking
 * like a perfectly ordinary polygon. Nothing downstream can tell — a partial
 * boundary IS a boundary, just the wrong one, and every area, clip and count
 * computed from it is quietly wrong.
 *
 * Deliberately loose. Rings close and share endpoints, so an exact match is
 * not expected; only a shortfall large enough to mean whole segments went
 * missing counts (§6.6 大型关系的装配校验).
 */
export function assemblyLooksComplete(geometry: any, rawNodeCount: number): boolean {
  if (rawNodeCount <= 50) return true
  return countVertices(geometry) >= rawNodeCount * 0.5
}

/** Stable dedup across extents, keyed by identity. */
export function dedupe(features: readonly Feature[]): Feature[] {
  const seen = new Set<string>()
  const out: Feature[] = []
  for (const feature of features) {
    const key = `${feature.properties.osm_type}/${feature.properties.osm_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(feature)
  }
  return out
}

export function toFeatureCollection(features: readonly Feature[]): string {
  return JSON.stringify({ type: "FeatureCollection", features })
}

export function geometrySummary(features: readonly Feature[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const feature of features) {
    const type = feature.geometry?.type ?? "null"
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

export type Family = "points" | "lines" | "polygons"

/** Single and multi variants are one family — GIS layers hold them together. */
export function family(type: string): Family {
  if (type === "Point" || type === "MultiPoint") return "points"
  if (type === "LineString" || type === "MultiLineString") return "lines"
  return "polygons"
}

export function splitByFamily(features: readonly Feature[]): Map<Family, Feature[]> {
  const groups = new Map<Family, Feature[]>()
  for (const feature of features) {
    const key = family(feature.geometry?.type ?? "")
    const list = groups.get(key) ?? []
    list.push(feature)
    groups.set(key, list)
  }
  return groups
}

/** The dropped-field tally as "key(count)", commonest first. */
export function formatDroppedFields(droppedFields: Map<string, number>, cap = 30): string[] {
  return [...droppedFields.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([key, count]) => `${key}(${count})`)
}
