import * as path from "path"

/* --- GeoCode: the handoff from `read` to ReadGeoData (GEOKERNEL §10.1 #10).
 *
 * `read` cannot open geographic data, and it fails at that in two different
 * ways depending on the format — which is why a pointer is worth a source
 * patch. The binary formats (.shp, .tif, .gpkg) hit its binary guard and end
 * at "Cannot read binary file", a dead end naming no alternative. The TEXT
 * ones (.geojson, .gml, .kml, .gpx, .asc) are worse: they sail straight
 * through, get read as plain text, and are capped mid-file with an invitation
 * to page onward — so the model receives a truncated fragment of a coordinate
 * array and is encouraged to keep asking for more of it.
 *
 * Zero dependencies beyond `path` on purpose: this is imported by upstream's
 * read.ts, and pulling the geo kernel into that module's graph to answer a
 * question about a filename extension would be a poor trade.
 *
 * The list is shared with ReadGeoData rather than mirrored into it. The old
 * build kept a hand-copied Set here and relied on someone remembering to edit
 * both; one array means the drift cannot happen. --- */

/**
 * The formats vector_read.py / raster_read.py were built and validated
 * against — a subset of the shared taxonomy's *_MAIN lists (tripwired as
 * such): advertising the whole taxonomy would claim formats the reader
 * scripts have never seen.
 */
export const VECTOR_SUPPORTED = ["shp", "geojson", "gpkg", "gml", "kml", "gpx", "fgb"]
export const RASTER_SUPPORTED = ["tif", "tiff", "img", "asc", "dem"]

/**
 * Which reader a path belongs to, or undefined for "not ours".
 *
 * The ONE judgement in the codebase about whether ReadGeoData opens a file.
 * `read` redirects on it and ReadGeoData accepts on it, so the redirect and
 * the acceptance are the same decision by construction rather than two
 * predicates that happen to agree — sharing the arrays alone still left the
 * `includes` check written twice, one on each side of the handoff.
 */
export type GeoKind = "vector" | "raster"

export function geoKind(filepath: string): GeoKind | undefined {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  if (VECTOR_SUPPORTED.includes(ext)) return "vector"
  if (RASTER_SUPPORTED.includes(ext)) return "raster"
  return undefined
}

/**
 * A redirect names the tool and stops.
 *
 * It used to say more, and both extras were wrong. "This is a geographic data
 * file" is a claim about the FILE, and a scan saved as `.tif` makes it false —
 * this function knows an extension, not a georeferencing (ReadGeoData decides
 * that, from the file itself). "…or preview its content" promised a mode that
 * exists for rasters only, so a caller who believed it and passed
 * `mode: "preview"` for a shapefile earned a refusal for doing as it was told.
 *
 * What is left is the one thing `read` actually knows: which tool opens this.
 * Where the caller goes from there is its own to work out.
 */
const REDIRECT = "Use the ReadGeoData tool to open this file."

/**
 * The message `read` returns for a file ReadGeoData handles, or undefined to
 * let upstream proceed untouched.
 *
 * Deliberately narrower than the shared taxonomy, and the boundary is the old
 * build's, kept for its reason: only redirect to a tool that will actually do
 * the job. Sidecars (.prj, .cpg, .dbf, .qmd) are not here because ReadGeoData
 * does not accept them as input — they are small text files worth reading
 * directly, and a handoff would send the caller somewhere that refuses it.
 * Geographic formats outside ReadGeoData's support (.nc, .tab, .osm …) are not
 * here either: naming another tool for those would be guessing at a workflow
 * — convert to what, and why — rather than handing off.
 */
export function geoHandoff(filepath: string): string | undefined {
  return geoKind(filepath) ? REDIRECT : undefined
}

export * as GeoHandoff from "./geo-handoff"
