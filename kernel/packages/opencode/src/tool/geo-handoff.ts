import * as path from "path"

/* --- GeoCode: the handoff from `read` to ReadGeoData (docs/TOOLS.md §7). Imports nothing beyond `path`, since
 * upstream read.ts imports this module. --- */

/**
 * The formats vector_read.py and raster_read.py open, deliberately narrower than the `*_MAIN` lists. geo-read.txt
 * spells them out again for the model, held to these arrays by a tripwire.
 */
export const VECTOR_SUPPORTED = ["shp", "geojson", "gpkg", "gml", "kml", "gpx", "fgb"]
export const RASTER_SUPPORTED = ["tif", "tiff", "img", "asc", "dem"]

/** `read` redirects on this and ReadGeoData accepts on it, so the two sides of the handoff cannot disagree. */
export type GeoKind = "vector" | "raster"

export function geoKind(filepath: string): GeoKind | undefined {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  if (VECTOR_SUPPORTED.includes(ext)) return "vector"
  if (RASTER_SUPPORTED.includes(ext)) return "raster"
  return undefined
}

/** Names the tool and nothing else (test/geocode-read-handoff.test.ts holds what it must not say). */
const REDIRECT = "Use the ReadGeoData tool to open this file."

/** Undefined lets upstream `read` proceed; sidecars and formats ReadGeoData cannot open stay out (docs/TOOLS.md §7). */
export function geoHandoff(filepath: string): string | undefined {
  return geoKind(filepath) ? REDIRECT : undefined
}

export * as GeoHandoff from "./geo-handoff"
