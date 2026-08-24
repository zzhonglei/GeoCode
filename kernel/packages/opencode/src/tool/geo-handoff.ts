import * as path from "path"

/* --- GeoCode: the handoff from `read` to ReadGeoData (GEOKERNEL §10.1 #10, docs/TOOLS.md §7).
 *
 * Nothing beyond `path` is imported: upstream's read.ts imports this module, and answering a question about a
 * filename extension is not worth pulling the geo kernel into that module's graph. --- */

/**
 * Narrower than the shared taxonomy's `*_MAIN` lists: these are the formats vector_read.py / raster_read.py
 * handle, and the rule is to redirect only to a tool that will do the job (docs/TOOLS.md §7). geo-read.txt spells
 * the same two lists out for the model, which is a hand-copy held together by a tripwire.
 */
export const VECTOR_SUPPORTED = ["shp", "geojson", "gpkg", "gml", "kml", "gpx", "fgb"]
export const RASTER_SUPPORTED = ["tif", "tiff", "img", "asc", "dem"]

/** Which reader a path belongs to; `read` redirects on this and ReadGeoData accepts on it, so the two sides of the
 * handoff are one decision rather than two predicates kept in agreement. */
export type GeoKind = "vector" | "raster"

export function geoKind(filepath: string): GeoKind | undefined {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  if (VECTOR_SUPPORTED.includes(ext)) return "vector"
  if (RASTER_SUPPORTED.includes(ext)) return "raster"
  return undefined
}

/**
 * Names the tool and nothing else — the two things it must not say are tripwired in
 * test/geocode-read-handoff.test.ts. Calling the file geographic data would be a claim about the file, which only
 * ReadGeoData can make; offering to preview it would promise a mode that exists for rasters only.
 */
const REDIRECT = "Use the ReadGeoData tool to open this file."

/** Undefined lets upstream `read` proceed untouched. Sidecars (.prj, .cpg, .dbf, .qmd) and geographic formats
 * ReadGeoData cannot open (.nc, .tab, .osm …) stay out of the set (docs/TOOLS.md §7). */
export function geoHandoff(filepath: string): string | undefined {
  return geoKind(filepath) ? REDIRECT : undefined
}

export * as GeoHandoff from "./geo-handoff"
