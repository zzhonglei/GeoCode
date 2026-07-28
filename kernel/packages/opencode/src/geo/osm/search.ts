export * as OsmSearch from "./search"

/* --- GeoCode: finding an object by name (docs/GEOKERNEL.md §6.8 检索是双引擎).
 *
 * Two services, asked in parallel, merged and ranked once. They recall very
 * different sets — the geocoder is forgiving about word order, missing
 * suffixes and address context; the feature service matches official names
 * literally, which is what reaches campus and parenthesised variants — and
 * **either one alone misses**. The merge is the point of asking twice. --- */

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
  /** Which engines found it. Two is the strongest confidence signal there is. */
  readonly sources: Set<string>
  transit: boolean
  siteParent?: string
}

/** Relation types that mean "a transport route", not "a place". */
const TRANSIT_RELATION_TYPES = new Set(["route", "route_master", "public_transport"])

/**
 * Whether this is a transport stop rather than the place it is named after.
 *
 * A stop named after a landmark is almost always noise in a place search, and
 * there are usually many of them — a metro station, its entrances, the bus
 * stops outside — so by count they can bury the one thing being looked for
 * (§6.8 对同名交通站点的降权).
 */
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
 * Merge a candidate into the set, keyed by identity.
 *
 * Existing values win: whichever engine spoke first had a complete answer for
 * the field it filled, and the second engine's blank must not overwrite it.
 * `transit` is the exception and combines with AND — one engine saying "this
 * is a real place" is enough to stop treating it as a stop.
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

/**
 * The ranking, from the four signals §6.8 names.
 *
 * The weights encode one ordering decision worth stating: **importance
 * dominates the dual-source bonus**. A famous place the geocoder knows well
 * must outrank an obscure namesake that happened to match both engines
 * literally — otherwise searching for a mountain returns a hill somewhere that
 * shares its name, purely because both engines saw the same string.
 */
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

/**
 * The first segment of a geocoder's display name.
 *
 * Used by the recovery path: when the literal search found no area, the
 * geocoder's canonical name is a better literal query than what the user typed
 * (§6.8 用地理编码服务返回的规范名反查要素服务).
 */
export function canonicalName(hit: GeocoderHit): string | undefined {
  const name = hit.display_name?.split(",")[0]?.trim()
  return name && name.length >= 2 ? name : undefined
}

/** Whether the set holds anything area-like, which is what the recovery path looks for. */
export function hasArea(candidates: Iterable<Candidate>): boolean {
  for (const candidate of candidates) {
    if ((candidate.type === "relation" || candidate.type === "way") && !candidate.transit) return true
  }
  return false
}
