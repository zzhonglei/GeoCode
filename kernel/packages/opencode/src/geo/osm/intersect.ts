export * as OsmIntersect from "./intersect"

/* --- GeoCode: replaying the boundary test Overpass could not run
 * (docs/GEOKERNEL.md §6.4).
 *
 * A boundary with more vertices than the server's polygon filter accepts is
 * widened outward before querying (`extent.ts`), so the answer covers more
 * ground than was asked for. This module narrows it back.
 *
 * **It is not a clip.** Nothing here cuts a feature. Overpass answers "every
 * feature that INTERSECTS this polygon", whole, and that is exactly what this
 * reproduces: the same question, asked locally against the real boundary
 * instead of the widened one. A road crossing the city line comes back entire,
 * the way it would have if the boundary had been simple enough to send.
 *
 * That equivalence is the whole design. A simple boundary is filtered by the
 * server; a complex one is filtered here; **both must produce the same set**.
 * Cutting features would break it — the server never cuts — and it would also
 * break provenance: a clipped way keeps its `osm_id` while its geometry is no
 * longer that object, which is an error nobody downstream can detect.
 *
 * Every judgement below errs the same way §6.4 does: when it cannot decide,
 * it KEEPS the feature. A superset is a correctable answer; a feature deleted
 * near the edge is one nobody can see is missing. --- */

export type Point = readonly [number, number]

/** One polygon of the boundary: an outer ring, and the holes cut out of it. */
export interface Polygon {
  readonly outer: readonly Point[]
  readonly holes: readonly (readonly Point[])[]
}

/**
 * Ray casting, counting crossings of a horizontal ray to the right.
 *
 * The half-open comparison (`>` on one end, not the other) is what stops a
 * vertex lying exactly on the ray from being counted twice — the classic way
 * this goes wrong, and boundaries drawn on a graticule produce such vertices
 * constantly.
 */
function inRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Inside the outer ring and outside every hole. */
export function inPolygon(point: Point, polygon: Polygon): boolean {
  if (!inRing(point, polygon.outer)) return false
  for (const hole of polygon.holes) if (inRing(point, hole)) return false
  return true
}

function orient(a: Point, b: Point, c: Point): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])
  return value > 0 ? 1 : value < 0 ? -1 : 0
}

/** With `c` known to be collinear with `ab`, does it lie on the segment? */
function within(a: Point, b: Point, c: Point): boolean {
  return (
    Math.min(a[0], b[0]) <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] &&
    c[1] <= Math.max(a[1], b[1])
  )
}

/**
 * Do two segments touch at all?
 *
 * The collinear cases below are not a formality. Administrative boundaries are
 * routinely drawn ALONG a road or a river, so a way lying exactly on the
 * boundary line is ordinary here, and the sign test alone reports those as
 * missing each other.
 */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = orient(a, b, c)
  const abd = orient(a, b, d)
  const cda = orient(c, d, a)
  const cdb = orient(c, d, b)
  if (abc !== abd && cda !== cdb) return true
  if (abc === 0 && within(a, b, c)) return true
  if (abd === 0 && within(a, b, d)) return true
  if (cda === 0 && within(c, d, a)) return true
  if (cdb === 0 && within(c, d, b)) return true
  return false
}

interface Edge {
  readonly a: Point
  readonly b: Point
}

/**
 * The boundary, prepared for repeated questioning.
 *
 * A grid rather than a tree: the edges of a boundary are spread along a closed
 * curve rather than clustered, which is the distribution a uniform grid handles
 * best, and it is thirty lines instead of a dependency. Measured on a 5000-vertex
 * boundary it turns the worst case — a thousand ways all lying against the edge
 * — from 2.7 seconds into under a tenth of one.
 */
export interface Index {
  readonly polygons: readonly Polygon[]
  readonly buckets: ReadonlyMap<number, readonly Edge[]>
  readonly minX: number
  readonly minY: number
  readonly stepX: number
  readonly stepY: number
  readonly cells: number
}

const CELLS = 64

export function index(polygons: readonly Polygon[]): Index {
  const edges: Edge[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const polygon of polygons) {
    for (const ring of [polygon.outer, ...polygon.holes]) {
      for (let i = 0; i < ring.length; i++) {
        // Closed by construction: GeoJSON asks for a repeated last vertex and
        // real files sometimes omit it, so the ring is walked as a cycle and a
        // zero-length edge dropped instead of trusting the file to say so.
        const a = ring[i]!
        const b = ring[(i + 1) % ring.length]!
        if (a[0] === b[0] && a[1] === b[1]) continue
        edges.push({ a, b })
        minX = Math.min(minX, a[0], b[0])
        minY = Math.min(minY, a[1], b[1])
        maxX = Math.max(maxX, a[0], b[0])
        maxY = Math.max(maxY, a[1], b[1])
      }
    }
  }
  // A degenerate span would divide by zero and put every edge in one cell,
  // which is correct but slow; a positive floor keeps it merely slow.
  const stepX = (maxX - minX) / CELLS || 1e-9
  const stepY = (maxY - minY) / CELLS || 1e-9
  const buckets = new Map<number, Edge[]>()
  const put = (edge: Edge) => {
    const x0 = cell(Math.min(edge.a[0], edge.b[0]), minX, stepX)
    const x1 = cell(Math.max(edge.a[0], edge.b[0]), minX, stepX)
    const y0 = cell(Math.min(edge.a[1], edge.b[1]), minY, stepY)
    const y1 = cell(Math.max(edge.a[1], edge.b[1]), minY, stepY)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x * (CELLS + 1) + y
        const held = buckets.get(key)
        if (held) held.push(edge)
        else buckets.set(key, [edge])
      }
    }
  }
  for (const edge of edges) put(edge)
  return { polygons, buckets, minX, minY, stepX, stepY, cells: CELLS }
}

function cell(value: number, origin: number, step: number): number {
  return Math.max(0, Math.min(CELLS, Math.floor((value - origin) / step)))
}

/** Is this point inside the boundary — any of its polygons, none of their holes? */
export function contains(idx: Index, point: Point): boolean {
  for (const polygon of idx.polygons) if (inPolygon(point, polygon)) return true
  return false
}

/** Does this segment touch the boundary anywhere? */
export function crosses(idx: Index, a: Point, b: Point): boolean {
  const x0 = cell(Math.min(a[0], b[0]), idx.minX, idx.stepX)
  const x1 = cell(Math.max(a[0], b[0]), idx.minX, idx.stepX)
  const y0 = cell(Math.min(a[1], b[1]), idx.minY, idx.stepY)
  const y1 = cell(Math.max(a[1], b[1]), idx.minY, idx.stepY)
  // An edge spanning several cells is stored in each of them, so the same one
  // can be reached twice; the check is cheap and the set would cost more.
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (const edge of idx.buckets.get(x * (CELLS + 1) + y) ?? []) {
        if (segmentsCross(a, b, edge.a, edge.b)) return true
      }
    }
  }
  return false
}

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
}

function line(coordinates: unknown, idx: Index): boolean {
  if (!Array.isArray(coordinates)) return true
  const points = coordinates.filter(isPoint)
  if (points.length === 0) return true
  for (const point of points) if (contains(idx, point)) return true
  for (let i = 0; i + 1 < points.length; i++) if (crosses(idx, points[i]!, points[i + 1]!)) return true
  return false
}

function area(coordinates: unknown, idx: Index): boolean {
  if (!Array.isArray(coordinates)) return true
  const outer = Array.isArray(coordinates[0]) ? coordinates[0].filter(isPoint) : []
  if (outer.length === 0) return true
  // A ring is a closed line, so the two tests a line needs cover most of it.
  if (line(outer, idx)) return true
  // What a line never needs: the feature may CONTAIN the whole study area —
  // a province-sized polygon has no vertex inside the boundary and no edge
  // crossing it, and is nonetheless an answer to the query.
  return idx.polygons.some((polygon) => polygon.outer[0] !== undefined && inRing(polygon.outer[0], outer))
}

/**
 * Does this GeoJSON geometry intersect the boundary?
 *
 * Unknown shapes answer `true`. A geometry this cannot read is a geometry it
 * cannot rule out, and §6.4's asymmetry decides every such case the same way:
 * keeping one feature too many costs a row in a table, dropping one costs a
 * fact that nobody can see is absent.
 */
export function intersects(geometry: unknown, idx: Index): boolean {
  const shape = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  switch (shape?.type) {
    case "Point":
      return isPoint(shape.coordinates) ? contains(idx, shape.coordinates) : true
    case "MultiPoint":
      return Array.isArray(shape.coordinates)
        ? shape.coordinates.some((point) => (isPoint(point) ? contains(idx, point) : true))
        : true
    case "LineString":
      return line(shape.coordinates, idx)
    case "MultiLineString":
      return Array.isArray(shape.coordinates) ? shape.coordinates.some((part) => line(part, idx)) : true
    case "Polygon":
      return area(shape.coordinates, idx)
    case "MultiPolygon":
      return Array.isArray(shape.coordinates) ? shape.coordinates.some((part) => area(part, idx)) : true
    case "GeometryCollection":
      return Array.isArray(shape.geometries) ? shape.geometries.some((child) => intersects(child, idx)) : true
    default:
      return true
  }
}
