export * as OsmCentroid from "./centroid"

import type { OsmConvert } from "./convert"

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

/** Area-weighted centroid of a ring, falling back to the vertex mean when degenerate. */
export function ringCentroid(ring: readonly Position[]): Position {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[i + 1]!
    const cross = x1 * y2 - x2 * y1
    area += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (Math.abs(area) < 1e-12) {
    const points = ring.slice(0, -1).length > 0 ? ring.slice(0, -1) : ring
    const sx = points.reduce((sum, point) => sum + point[0], 0)
    const sy = points.reduce((sum, point) => sum + point[1], 0)
    return [sx / points.length, sy / points.length]
  }
  return [cx / (3 * area), cy / (3 * area)]
}

export function ringArea(ring: readonly Position[]): number {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1]
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

function representativePoint(geometry: any): Position | undefined {
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
      dropped.push(`${feature.properties.osm_type}/${feature.properties.osm_id}`)
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
