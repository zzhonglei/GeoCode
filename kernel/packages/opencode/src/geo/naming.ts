export * as GeoNaming from "./naming"

import path from "node:path"

/* --- GeoCode: the one shape a repeated output is named with
 * (docs/GEOKERNEL.md §6.7, §4.12).
 *
 * Two tools write to the user's disk — OSM's downloader and RunQgisAlgorithm —
 * and neither may overwrite. Undo does not reach what they write: geographic
 * data is outside the checkpoint mechanism by design (§10.1 #6), so a file
 * written over is gone with nothing to restore it from. Numbering is what both
 * do instead.
 *
 * **There is one of it, for the same reason `georeference.ts` is one of it.**
 * OSM had the only implementation, and its header had ALREADY come apart from
 * it: the comment said it numbered "the way a browser does" while the code
 * produced `out-1.geojson`, which is a programmer's shape and not a browser's.
 * That is what a lone implementation costs — nothing holds a claim about the
 * rule level with the rule, and nobody noticed for as long as both halves were
 * only ever read together. Giving RunQgisAlgorithm a copy would have made two
 * of them; this module is the copy that was not made. What differs between the
 * callers is only what "taken" MEANS — OSM has to count sibling files it
 * invents itself — so that is the parameter, and the shape is not.
 *
 * **The browser's shape, and not a programmer's.** `out (1).shp`, not
 * `out-1.shp` or `out_1.shp`. The audience is geographers, and this is the one
 * they already read every time they download the same file twice. It costs a
 * space in a path, which was measured rather than assumed: both QGIS providers
 * accept it on a real 3.44 install, including the `gdal:` family that builds a
 * command line, because QGIS quotes the path itself.
 *
 * ⚠️ Measured on macOS. Windows has never been run, and command line quoting is
 * where it differs most. --- */

/** Enough that reaching it means something is wrong, not that someone was busy. */
export const MAX_ATTEMPTS = 10_000

/**
 * The nth alternative to a name: `out.shp` at 1 becomes `out (1).shp`.
 *
 * The number goes before the extension and never after it. Every reader in a
 * GIS chain dispatches on the extension, so a name ending `(1)` is one no tool
 * downstream can open — including the tool that was asked to produce it.
 */
export function numbered(base: string, attempt: number): string {
  const extension = path.extname(base)
  const stem = path.join(path.dirname(base), path.basename(base, extension))
  return `${stem} (${attempt})${extension}`
}

/**
 * The first name at or after `requested` that nothing has claimed.
 *
 * `taken` is the caller's, because only the caller knows what a claim is: a
 * single file for an algorithm output, a file OR any of the siblings this run
 * might split into for a download.
 *
 * @param exhausted the message when every candidate is spoken for — the two
 * callers give different advice, and this is too rare to be worth a shared
 * sentence that fits neither.
 */
export function firstFree(requested: string, taken: (candidate: string) => boolean, exhausted: string): string {
  if (!taken(requested)) return requested
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = numbered(requested, attempt)
    if (!taken(candidate)) return candidate
  }
  throw new Error(exhausted)
}
