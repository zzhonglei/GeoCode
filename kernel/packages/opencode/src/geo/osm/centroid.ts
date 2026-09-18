export * as OsmCentroid from "./centroid"

import type { OsmConvert } from "./convert"
import { OsmQuery } from "./query"

/* --- GeoCode: collapsing features to representative points, so a point dataset collects every type rather than
 * `node` alone, which drops everything mapped as an area (docs/GEOKERNEL.md §6.8). --- */

type Position = [number, number]

/** Relative to the first vertex, without which a small ring far from the origin can land outside its own bbox. */
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
      // The largest part, so a country's representative point does not land on an offshore island.
      const largest = [...geometry.coordinates].sort(
        (a: Position[][], b: Position[][]) => ringArea(b[0] ?? []) - ringArea(a[0] ?? []),
      )[0]
      return largest?.[0] ? ringCentroid(largest[0]) : undefined
    }
    default:
      return undefined
  }
}

/** Finite or nothing: an empty ring yields a truthy `[NaN, NaN]`, which `JSON.stringify` writes as invalid GeoJSON. */
function representativePoint(geometry: any): Position | undefined {
  const point = pointOf(geometry)
  return point && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : undefined
}

/** A feature already a point passes through untouched, so `original_geometry` marks exactly the converted ones. */
export function normalize(features: readonly OsmConvert.Feature[]): {
  features: OsmConvert.Feature[]
  dropped: string[]
} {
  const out: OsmConvert.Feature[] = []
  const dropped: string[] = []
  for (const feature of features) {
    const point = representativePoint(feature.geometry)
    if (!point) {
      // `W1`, the shape `OsmQuery.parseRef` accepts, because the caller is told to fetch these objects on their own.
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
