export * as Georeference from "./georeference"

/* --- GeoCode: where a raster's georeferencing comes from, or that it has none
 * (docs/GEOKERNEL.md §7.9).
 *
 * A `.tif` is not necessarily geographic data: a scan, a figure or a screenshot
 * parses perfectly and carries nothing that places it on the earth. Both faces
 * need the answer and use it differently — the tool face refuses to open one,
 * the interface shows it as a picture instead of putting it on a map.
 *
 * Two things decide the shape.
 *
 * **It answers "is there georeferencing", not "is this remote sensing".** A
 * raster of administrative boundaries is not imagery and is still geographic
 * data; an unrectified satellite scene IS imagery and carries no transform at
 * all. The second question has no answer a file can give. The first does.
 *
 * **It is asymmetric, deliberately.** Mistaking a picture for data costs one
 * metadata read that says `none`. Mistaking a scene for a picture costs the
 * user their data — refused, with nothing to explain why. So ANY evidence is
 * enough and only the total absence of all five is `none`, which is the same
 * reasoning §6.4 applies to a widened download.
 *
 * **There is one of it.** The two raster pipelines run in different languages
 * and neither can call the other (§7.9), so the rule is kept out of both: each
 * side REPORTS the five facts — the Python scripts in their JSON, `gdalinfo`
 * through the inspector — and the verdict is reached here, once. Two
 * implementations held level by a test can still drift between test runs; a
 * single one cannot drift at all. --- */

/**
 * Where a raster's georeferencing comes from. `none` is an ordinary image.
 *
 * Ordered by how directly usable it is, which is also the order it is tested
 * in: a transform can be used as it stands; control points and rational
 * polynomials describe a scene that has not been rectified yet; a coordinate
 * system with no transform names the space without placing anything in it.
 */
export const KINDS = ["transform", "gcp", "rpc", "geolocation", "crs-only", "none"] as const

/** Named once so the type and the HTTP schema cannot come apart. */
export type Kind = (typeof KINDS)[number]

export interface Evidence {
  /** The six affine coefficients, absent when the file carries none. */
  readonly transform?: readonly number[]
  /** Only whether there is one: the verdict never needs to know which. */
  readonly projection?: boolean
  readonly gcpCount?: number
  readonly rpc?: boolean
  readonly geolocation?: boolean
}

/**
 * True when the six coefficients place pixels somewhere.
 *
 * Two ways they do not. GDAL hands back the IDENTITY transform for a file that
 * has none — the same shape as a real one, which is why absence has to be
 * named here rather than assumed. And a transform whose pixel size is zero
 * cannot be inverted at all: that is a damaged file, not a placement.
 */
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

/**
 * The five facts as the two raster scripts report them, in one place.
 *
 * `raster_read.py` puts this on its payload and `raster_preview.py` on its
 * metadata, under the same key and the same shape — so metadata mode and
 * preview mode cannot come back with different verdicts about one file.
 */
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
