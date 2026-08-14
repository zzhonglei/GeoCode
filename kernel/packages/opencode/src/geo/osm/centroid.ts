export * as OsmCentroid from "./centroid"

import type { OsmConvert } from "./convert"
import { OsmQuery } from "./query"

/* --- GeoCode: collapsing features to representative points
 * (docs/GEOKERNEL.md §6.8 几何归一化).
 *
 * Not a convenience. The correct way to build a point dataset of facilities is
 * to collect EVERY type and normalize afterwards — asking only for point
 * elements silently omits everything mapped as an area, and for most kinds of
 * facility that is the majority of them. A hospital is a building; a park is a
 * polygon; a school is a campus. Requesting `node` returns the handful that
 * happen to be mapped as a dot and reports success. --- */

type Position = [number, number]

/**
 * Area-weighted centroid of a ring, falling back to the vertex mean when degenerate.
 *
 * **Computed relative to the ring's first vertex, and the shift is not
 * optional.** The cross products are differences of products of the raw
 * coordinates, and in longitude/latitude those products are around 3500 while
 * a building-sized ring makes them differ by about 0.01 — five significant
 * digits cancel on every term, and the accumulated error reaches the size of
 * the answer. Measured on a real 40 m car park in Wuhan: the unshifted result
 * landed 2 m outside the ring's own bounding box, which a centroid cannot do.
 *
 * The failure is worst exactly where this is used most — small features, far
 * from the origin, which is what a city is made of.
 */
export function ringCentroid(ring: readonly Position[]): Position {
  const [ox, oy] = ring[0] ?? [0, 0]
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i]![0] - ox
    const y1 = ring[i]![1] - oy
    const x2 = ring[i + 1]![0] - ox
    const y2 = ring[i + 1]![1] - oy
    const cross = x1 * y2 - x2 * y1
    area += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (Math.abs(area) < 1e-15) {
    const points = ring.slice(0, -1).length > 0 ? ring.slice(0, -1) : ring
    const sx = points.reduce((sum, point) => sum + point[0], 0)
    const sy = points.reduce((sum, point) => sum + point[1], 0)
    return [sx / points.length, sy / points.length]
  }
  return [cx / (3 * area) + ox, cy / (3 * area) + oy]
}

/** Ring area, shifted for the same reason `ringCentroid` is. */
export function ringArea(ring: readonly Position[]): number {
  const [ox, oy] = ring[0] ?? [0, 0]
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += (ring[i]![0] - ox) * (ring[i + 1]![1] - oy) - (ring[i + 1]![0] - ox) * (ring[i]![1] - oy)
  }
  return Math.abs(area / 2)
}

function lineLength(line: readonly Position[]): number {
  let total = 0
  for (let i = 0; i < line.length - 1; i++) {
    total += Math.hypot(line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1])
  }
  return total
}

/** The point half way along a line by distance, not by vertex count. */
export function lineMidpoint(line: readonly Position[]): Position {
  if (line.length === 1) return line[0]!
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < line.length - 1; i++) {
    const length = Math.hypot(line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1])
    lengths.push(length)
    total += length
  }
  if (total === 0) return line[0]!
  let walked = 0
  for (let i = 0; i < lengths.length; i++) {
    if (walked + lengths[i]! >= total / 2) {
      const t = (total / 2 - walked) / lengths[i]!
      return [line[i]![0] + (line[i + 1]![0] - line[i]![0]) * t, line[i]![1] + (line[i + 1]![1] - line[i]![1]) * t]
    }
    walked += lengths[i]!
  }
  return line[line.length - 1]!
}

function pointOf(geometry: any): Position | undefined {
  switch (geometry?.type) {
    case "Point":
      return geometry.coordinates
    case "LineString":
      return lineMidpoint(geometry.coordinates)
    case "MultiLineString": {
      const longest = [...geometry.coordinates].sort((a: Position[], b: Position[]) => lineLength(b) - lineLength(a))[0]
      return longest ? lineMidpoint(longest) : undefined
    }
    case "Polygon":
      return geometry.coordinates[0] ? ringCentroid(geometry.coordinates[0]) : undefined
    case "MultiPolygon": {
      // The largest part, so a country's representative point does not land on
      // an offshore island.
      const largest = [...geometry.coordinates].sort(
        (a: Position[][], b: Position[][]) => ringArea(b[0] ?? []) - ringArea(a[0] ?? []),
      )[0]
      return largest?.[0] ? ringCentroid(largest[0]) : undefined
    }
    default:
      return undefined
  }
}

/**
 * A point that can be plotted, or nothing.
 *
 * The finiteness check belongs here rather than in each branch above. A ring
 * with no vertices divides by zero, so `ringCentroid` answers `[NaN, NaN]` —
 * an array, therefore truthy, therefore counted as a success. It left as
 * `[null, null]` the moment `JSON.stringify` saw it: invalid GeoJSON, written
 * to the user's file, and absent from the loss list that exists to name
 * precisely this. Every branch above can go degenerate the same way, and the
 * contract all of them owe is the one in this docstring.
 */
function representativePoint(geometry: any): Position | undefined {
  const point = pointOf(geometry)
  return point && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : undefined
}

/**
 * Collapse every feature to one point, recording what it used to be.
 *
 * `original_geometry` is what keeps the transformation traceable: a point that
 * was a campus is a different fact from a point that was mapped as a dot, and
 * an analysis may well care.
 */
export function normalize(features: readonly OsmConvert.Feature[]): {
  features: OsmConvert.Feature[]
  dropped: string[]
} {
  const out: OsmConvert.Feature[] = []
  const dropped: string[] = []
  for (const feature of features) {
    const point = representativePoint(feature.geometry)
    if (!point) {
      // The id shape `OsmGetObjects` parses, which is the whole point of naming
      // these rather than counting them: the caller is being told to fetch them
      // on their own. `way/1` is not that shape — `OsmQuery.parseRef` throws on
      // it — so half the list arrived unusable, from the half of the pipeline
      // that filled it here instead of in `convert.ts`.
      dropped.push(
        OsmQuery.formatRef({ type: String(feature.properties.osm_type), id: Number(feature.properties.osm_id) }),
      )
      continue
    }
    if (feature.geometry.type === "Point") {
      out.push(feature)
      continue
    }
    out.push({
      type: "Feature",
      properties: { ...feature.properties, original_geometry: feature.geometry.type },
      geometry: { type: "Point", coordinates: point },
    })
  }
  return { features: out, dropped }
}
