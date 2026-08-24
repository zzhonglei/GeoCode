export * as OsmConvert from "./convert"

import osm2geojson from "osm2geojson-lite"
import { OsmQuery } from "./query"

/* --- GeoCode: OSM elements into features (docs/GEOKERNEL.md §6.6). Assembly is the library's; what is here is
 * picking out the feature that was asked for, the field set, and the check for a partial assembly. --- */

/** Classification keys in priority order — a category is the first one present. */
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

/** Always written, whatever the policy keeps. */
export const CORE_FIELDS = ["osm_id", "osm_type", "name", "category"] as const

/** Consumed by a core column, so never counted as dropped. */
const CORE_TAG_KEYS = new Set(["name"])

/** The library mixes these into properties: `id` is a string, so without this `rawTags` would pass it as a tag. */
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

/** The keys the download was queried by, plus any the caller named; `*` asks for lossless instead of a field. */
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
  /** Elements that matched but would not assemble. */
  readonly unassembled: string[]
  /** Dropped tag keys with counts, so the caller can ask again for what it lost. */
  readonly droppedFields: Map<string, number>
}

function tally(target: Map<string, number>, keys: readonly string[]) {
  for (const key of keys) target.set(key, (target.get(key) ?? 0) + 1)
}

/**
 * One element per call, which `out geom` allows because each carries its geometry inline. Handed the whole set, the
 * library lets elements consume one another, and a relation that will not assemble takes its members with it (§6.6).
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
 * Only ever for one object, because the interference above applies to any batch. Used on the OSM API's `/full`
 * response, where a relation's geometry sits in sibling elements and element-by-element assembles nothing at all.
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
 * A partial boundary is still a shape nothing downstream can question, so a large one is checked against the nodes
 * it was built from. Small objects are exempt and the ratio is generous because the two counts never line up
 * exactly — only a shortfall big enough to mean whole segments went missing counts (§6.6 大型关系的装配校验).
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

export function formatDroppedFields(droppedFields: Map<string, number>, cap = 30): string[] {
  return [...droppedFields.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([key, count]) => `${key}(${count})`)
}
