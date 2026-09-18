export * as OsmSearch from "./search"

/* --- GeoCode: finding an object by name, merging and ranking the geocoder and the feature service together because
 * either alone misses (docs/GEOKERNEL.md §6.8). --- */

export type OsmType = "relation" | "way" | "node"

export interface Candidate {
  readonly type: OsmType
  readonly id: number
  name?: string
  className?: string
  classValue?: string
  adminLevel?: string
  center?: { lat: number; lon: number }
  importance?: number
  displayName?: string
  /** Which lookups found it; more than one earns the bonus in `score`, including two paths of one engine. */
  readonly sources: Set<string>
  transit: boolean
  siteParent?: string
}

/** Relation types that mean "a transport route", not "a place". */
const TRANSIT_RELATION_TYPES = new Set(["route", "route_master", "public_transport"])

/** Stops named after a landmark outnumber it in a place search, so `score` pushes them down. */
export function isTransit(tags: Record<string, string>): boolean {
  if (tags.public_transport) return true
  if (tags.highway === "bus_stop") return true
  if (tags.railway && ["station", "halt", "tram_stop", "subway_entrance", "platform"].includes(tags.railway))
    return true
  if (tags.type && TRANSIT_RELATION_TYPES.has(tags.type)) return true
  return false
}

const CLASS_KEYS = [
  "boundary",
  "amenity",
  "natural",
  "leisure",
  "landuse",
  "tourism",
  "place",
  "building",
  "highway",
  "railway",
  "shop",
  "waterway",
  "public_transport",
  "type",
] as const

function deriveClass(tags: Record<string, string>): { key: string; value: string } | undefined {
  for (const key of CLASS_KEYS) {
    if (tags[key]) return { key, value: tags[key]! }
  }
  return undefined
}

/**
 * Filled fields win, so a later engine's blank cannot erase an earlier engine's answer. `transit` is the exception
 * and is ANDed: it is a guess from tags, and one engine not making it is enough to stop the penalty.
 */
export function upsert(into: Map<string, Candidate>, incoming: Candidate) {
  const key = `${incoming.type}/${incoming.id}`
  const existing = into.get(key)
  if (!existing) {
    into.set(key, incoming)
    return
  }
  for (const source of incoming.sources) existing.sources.add(source)
  existing.name ??= incoming.name
  existing.className ??= incoming.className
  existing.classValue ??= incoming.classValue
  existing.adminLevel ??= incoming.adminLevel
  existing.center ??= incoming.center
  existing.importance ??= incoming.importance
  existing.displayName ??= incoming.displayName
  existing.siteParent ??= incoming.siteParent
  existing.transit = existing.transit && incoming.transit
}

export function fromElement(element: any, source: string, siteParent?: string): Candidate {
  const tags: Record<string, string> = element.tags ?? {}
  const derived = deriveClass(tags)
  return {
    type: element.type,
    id: element.id,
    name: tags.name,
    className: derived?.key,
    classValue: derived?.value,
    adminLevel: tags.admin_level,
    center: element.center ?? (typeof element.lat === "number" ? { lat: element.lat, lon: element.lon } : undefined),
    sources: new Set([source]),
    transit: isTransit(tags),
    siteParent,
  }
}

export interface GeocoderHit {
  readonly osm_type?: string
  readonly osm_id?: number
  readonly class?: string
  readonly type?: string
  readonly importance?: number
  readonly display_name?: string
}

export function fromGeocoder(hit: GeocoderHit): Candidate | undefined {
  if (hit.osm_type !== "relation" && hit.osm_type !== "way" && hit.osm_type !== "node") return undefined
  if (typeof hit.osm_id !== "number") return undefined
  return {
    type: hit.osm_type,
    id: hit.osm_id,
    className: hit.class,
    classValue: hit.type,
    importance: hit.importance,
    displayName: hit.display_name,
    sources: new Set(["geocoder"]),
    transit: hit.class === "highway" && hit.type === "bus_stop",
  }
}

/** Importance outweighs the dual-source bonus, so a well-known place beats an obscure namesake both engines matched. */
export function score(candidate: Candidate): number {
  let value = 0
  if (candidate.sources.size > 1) value += 1.5
  value += (candidate.importance ?? 0) * 8
  if (candidate.type === "relation") value += 2
  if (candidate.type === "way") value += 1
  if (candidate.transit) value -= 6
  return value
}

export function rank(candidates: Iterable<Candidate>, limit = 25): Candidate[] {
  return [...candidates].sort((a, b) => score(b) - score(a)).slice(0, limit)
}

/** The first segment of a display name, which is the place itself with the address context after it dropped. */
export function canonicalName(hit: GeocoderHit): string | undefined {
  const name = hit.display_name?.split(",")[0]?.trim()
  return name && name.length >= 2 ? name : undefined
}

/** Area-like: a relation or way, transit excluded, since a downweighted stop is not the area a caller is missing. */
export function hasArea(candidates: Iterable<Candidate>): boolean {
  for (const candidate of candidates) {
    if ((candidate.type === "relation" || candidate.type === "way") && !candidate.transit) return true
  }
  return false
}
