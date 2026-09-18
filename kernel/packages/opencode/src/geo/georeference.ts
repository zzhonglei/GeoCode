export * as Georeference from "./georeference"

/* --- GeoCode: the one verdict both raster pipelines reach from the five facts each of them reports separately
 * (docs/GEOKERNEL.md §7.9). --- */

/** Also the HTTP schema's literal list, so the type and the schema cannot come apart. */
export const KINDS = ["transform", "gcp", "rpc", "geolocation", "crs-only", "none"] as const

export type Kind = (typeof KINDS)[number]

export interface Evidence {
  readonly transform?: readonly number[]
  readonly projection?: boolean
  readonly gcpCount?: number
  readonly rpc?: boolean
  readonly geolocation?: boolean
}

/** GDAL hands back the identity transform for a file that has none, so absence is named here rather than assumed. */
function usable(transform: Evidence["transform"]): boolean {
  if (!transform || transform.length !== 6) return false
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = transform
  if (pixelWidth === 0 || pixelHeight === 0) return false
  return !(
    originX === 0 &&
    pixelWidth === 1 &&
    rowRotation === 0 &&
    originY === 0 &&
    columnRotation === 0 &&
    pixelHeight === 1
  )
}

export function of(evidence: Evidence): Kind {
  if (usable(evidence.transform)) return "transform"
  if ((evidence.gcpCount ?? 0) > 0) return "gcp"
  if (evidence.rpc) return "rpc"
  if (evidence.geolocation) return "geolocation"
  if (evidence.projection) return "crs-only"
  return "none"
}

/** The snake_case shape both QGIS raster scripts report under `georeferencing`; GDAL builds `Evidence` itself. */
export function reported(source: unknown): Evidence {
  const facts = (source ?? {}) as Record<string, unknown>
  return {
    transform: Array.isArray(facts.transform) ? (facts.transform as number[]) : undefined,
    projection: facts.projection === true,
    gcpCount: typeof facts.gcp_count === "number" ? facts.gcp_count : 0,
    rpc: facts.rpc === true,
    geolocation: facts.geolocation === true,
  }
}
