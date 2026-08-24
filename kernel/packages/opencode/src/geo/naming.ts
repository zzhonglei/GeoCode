export * as GeoNaming from "./naming"

import path from "node:path"

/* --- GeoCode: how a repeated output is renamed (docs/GEOKERNEL.md §6.7, §4.12).
 *
 * Neither caller may overwrite — geodata is outside the checkpoint mechanism (§10.1 #6) — so both number through
 * here. QGIS quotes paths itself, so the space in `out (1).shp` is safe: measured on a real 3.44 install including
 * the `gdal:` family, which builds a command line. --- */

/** Enough that reaching it means something is wrong, not that someone was busy. */
export const MAX_ATTEMPTS = 10_000

/** `out.shp` at 1 becomes `out (1).shp` — before the extension, because every reader in a GIS chain dispatches on it. */
export function numbered(base: string, attempt: number): string {
  const extension = path.extname(base)
  const stem = path.join(path.dirname(base), path.basename(base, extension))
  return `${stem} (${attempt})${extension}`
}

/** `taken` is the caller's: a claim can be one file, or every sibling a download might split into. */
export function firstFree(requested: string, taken: (candidate: string) => boolean, exhausted: string): string {
  if (!taken(requested)) return requested
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = numbered(requested, attempt)
    if (!taken(candidate)) return candidate
  }
  throw new Error(exhausted)
}
