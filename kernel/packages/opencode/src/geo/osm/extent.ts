export * as OsmExtent from "./extent"

import { readFileSync } from "node:fs"
import path from "node:path"
import { OsmQuery } from "./query"

/* --- GeoCode: the spatial extent contract (docs/GEOKERNEL.md §6.4).
 *
 * One string with an explicit kind prefix, so the four forms can never be
 * mistaken for one another:
 *
 *   area:R10717504                    an OSM relation, used as an area
 *   bbox:30.52,114.34,30.56,114.38    south,west,north,east in EPSG:4326
 *   around:1000,30.54,114.37          radius in metres, then centre
 *   file:/abs/path/boundary.geojson   a local study-area boundary
 *
 * THE SUPERSET RULE governs everything below it:
 *
 *   any spatial reduction of a boundary must produce a SUPERSET of it.
 *
 * The asymmetry is the whole argument. Downloading too much can be clipped
 * afterwards, exactly and at leisure. Downloading too little cannot be
 * noticed at all — features near the edge are simply absent, and nobody can
 * see what is not there. That is the worst failure available to a data
 * acquisition tool, so every approximation here is chosen to err outward. --- */

/** Vertices the server accepts in one polygon filter, with margin. */
const MAX_POLY_VERTICES = 300
/** Rings queried individually before falling back to one bounding box over all. */
const MAX_RINGS = 8

export type Point = readonly [number, number]

export interface Resolved {
  readonly spatial: OsmQuery.Spatial
  /** Human-readable, for the caller's report. */
  readonly label: string
  /**
   * True when the extent is exactly the boundary asked for.
   *
   * False means the query covers MORE than requested and the result needs
   * clipping. It is never the other way round.
   */
  readonly exact: boolean
}

export function parse(spec: string, readFile: (file: string) => string = defaultRead): Resolved {
  const text = spec.trim()
  const separator = text.indexOf(":")
  if (separator === -1) {
    throw new Error(
      `"${spec}" is not an extent: expected "area:R<id>", "bbox:S,W,N,E", "around:radius_m,lat,lon" or "file:/abs/path.geojson"`,
    )
  }
  const kind = text.slice(0, separator).toLowerCase()
  const value = text.slice(separator + 1).trim()
  switch (kind) {
    case "area":
      return fromArea(value)
    case "bbox":
      return fromBbox(value)
    case "around":
      return fromAround(value)
    case "file":
      return fromFile(value, readFile)
    default:
      throw new Error(`"${kind}" is not an extent kind: expected area, bbox, around or file`)
  }
}

function fromArea(value: string): Resolved {
  const ref = OsmQuery.parseRef(value)
  const id = OsmQuery.areaId(ref)
  return {
    spatial: { prelude: `area(${id})->.a;`, filters: ["(area.a)"] },
    label: `area ${OsmQuery.formatRef(ref)}`,
    exact: true,
  }
}

function fromBbox(value: string): Resolved {
  const parts = value.split(",").map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`"${value}" is not a bounding box: expected four numbers, south,west,north,east`)
  }
  const [south, west, north, east] = parts as [number, number, number, number]
  if (south >= north) throw new Error(`south (${south}) must be below north (${north})`)
  if (Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) {
    throw new Error("bounding box coordinates fall outside the WGS84 range")
  }
  return {
    spatial: { prelude: "", filters: [`(${south},${west},${north},${east})`] },
    label: `bbox ${south},${west},${north},${east}`,
    exact: true,
  }
}

function fromAround(value: string): Resolved {
  const parts = value.split(",").map((part) => Number(part.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`"${value}" is not a radius extent: expected radius_m,lat,lon`)
  }
  const [radius, lat, lon] = parts as [number, number, number]
  if (radius <= 0 || radius > 100_000) throw new Error(`a radius of ${radius} m is outside the supported 1..100000`)
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("the centre falls outside the WGS84 range")
  return {
    spatial: { prelude: "", filters: [`(around:${radius},${lat},${lon})`] },
    label: `${radius} m around ${lat},${lon}`,
    exact: true,
  }
}

function defaultRead(file: string): string {
  return readFileSync(file, "utf-8")
}

function fromFile(value: string, readFile: (file: string) => string): Resolved {
  const extension = path.extname(value).toLowerCase()
  if (extension !== ".geojson" && extension !== ".json") {
    throw new Error(
      `a boundary file must be GeoJSON (.geojson or .json), not "${extension}". Convert it first, in EPSG:4326.`,
    )
  }
  let raw: string
  try {
    raw = readFile(value)
  } catch {
    throw new Error(`the boundary file could not be read: ${value}`)
  }
  let document: unknown
  try {
    document = JSON.parse(raw.replace(/^﻿/, ""))
  } catch {
    throw new Error(`the boundary file is not valid JSON: ${value}`)
  }

  const rings = outerRings(document)
  if (rings.length === 0) throw new Error(`the boundary file holds no Polygon or MultiPolygon geometry: ${value}`)
  for (const ring of rings) assertWgs84(ring, value)
  const name = path.basename(value)

  // More parts than we will query one by one. One box over everything is a
  // superset of all of them — coarse, but never short.
  if (rings.length > MAX_RINGS) {
    return {
      spatial: { prelude: "", filters: [boundingFilter(rings)] },
      label: `bounding box of ${name} (${rings.length} polygons, too many to filter individually)`,
      exact: false,
    }
  }

  const filters: string[] = []
  let approximated = false
  for (const ring of rings) {
    const deduped = dropRepeats(ring)
    if (deduped.length <= MAX_POLY_VERTICES) {
      filters.push(polygonFilter(deduped))
      continue
    }
    // Too detailed to send as-is. The convex hull is the reduction that CANNOT
    // lose anything: it contains every original vertex by construction. A
    // conventional line simplifier would be a better fit visually and a
    // disaster here — it cuts inward, and every metre it cuts is a strip of
    // features that vanish without trace (§6.4 不使用常规的线简化算法).
    approximated = true
    const hull = convexHull(deduped)
    filters.push(hull.length <= MAX_POLY_VERTICES ? polygonFilter(hull) : boundingFilter([ring]))
  }

  return {
    spatial: { prelude: "", filters },
    label:
      `boundary file ${name} (${rings.length} polygon${rings.length > 1 ? "s" : ""}` +
      `${approximated ? ", reduced to convex hulls" : ""})`,
    exact: !approximated,
  }
}

function polygonFilter(ring: readonly Point[]): string {
  return `(poly:"${ring.map(([lon, lat]) => `${lat} ${lon}`).join(" ")}")`
}

function boundingFilter(rings: readonly (readonly Point[])[]): string {
  let south = 90
  let west = 180
  let north = -90
  let east = -180
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < south) south = lat
      if (lat > north) north = lat
      if (lon < west) west = lon
      if (lon > east) east = lon
    }
  }
  return `(${south},${west},${north},${east})`
}

/**
 * Every outer ring in the document, largest first.
 *
 * All of them, not the biggest: a study area made of separated parts is
 * ordinary, and keeping only the largest would drop the others without a word.
 */
export function outerRings(document: unknown): Point[][] {
  const rings: Point[][] = []
  const visit = (geometry: any) => {
    if (!geometry || typeof geometry !== "object") return
    if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates?.[0])) rings.push(geometry.coordinates[0])
    if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
      for (const polygon of geometry.coordinates) if (Array.isArray(polygon?.[0])) rings.push(polygon[0])
    }
    if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
      for (const child of geometry.geometries) visit(child)
    }
  }
  const root = document as any
  if (root?.type === "FeatureCollection" && Array.isArray(root.features)) {
    for (const feature of root.features) visit(feature?.geometry)
  } else if (root?.type === "Feature") {
    visit(root.geometry)
  } else {
    visit(root)
  }
  return rings
    .map((ring) =>
      ring.filter(
        (point): point is Point => Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number",
      ),
    )
    .filter((ring) => ring.length >= 4)
    .sort((a, b) => b.length - a.length)
}

function assertWgs84(ring: readonly Point[], file: string) {
  for (const [lon, lat] of ring.slice(0, 50)) {
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new Error(
        `${file} does not look like EPSG:4326 — found the coordinate ${lon},${lat}. Reproject it to WGS84 first.`,
      )
    }
  }
}

function dropRepeats(ring: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const point of ring) {
    const last = out[out.length - 1]
    if (last && last[0] === point[0] && last[1] === point[1]) continue
    out.push(point)
  }
  return out
}

/**
 * Andrew's monotone chain convex hull, returned as a closed ring.
 *
 * Guaranteed to contain every input point — which is the entire reason it is
 * used here rather than a simplifier that would follow the boundary more
 * closely (§6.4).
 */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const unique: Point[] = []
  for (const point of sorted) {
    const last = unique[unique.length - 1]
    if (last && last[0] === point[0] && last[1] === point[1]) continue
    unique.push(point)
  }
  if (unique.length <= 3) return [...unique, unique[0]!]

  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Point[] = []
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Point[] = []
  for (let i = unique.length - 1; i >= 0; i--) {
    const point = unique[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop()
    upper.push(point)
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  hull.push(hull[0]!)
  return hull
}

/**
 * Whether every point lies inside or on the ring.
 *
 * Not used in production — it exists so the superset rule can be TESTED rather
 * than asserted, which for the one rule this module is built around is worth
 * the few lines.
 */
export function containsAll(ring: readonly Point[], points: readonly Point[]): boolean {
  return points.every((point) => inside(ring, point))
}

function inside(ring: readonly Point[], point: Point): boolean {
  const [x, y] = point
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    // On an edge counts as inside: the hull passes through the original
    // vertices, and those must not read as outside it.
    const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi)
    const withinX = Math.min(xi, xj) - 1e-12 <= x && x <= Math.max(xi, xj) + 1e-12
    const withinY = Math.min(yi, yj) - 1e-12 <= y && y <= Math.max(yi, yj) + 1e-12
    if (Math.abs(cross) < 1e-12 && withinX && withinY) return true
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
