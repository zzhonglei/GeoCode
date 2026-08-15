export * as QgisDestination from "./destination"

import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { GeoNaming } from "../naming"
import type { Algorithm } from "./catalog"

/* --- GeoCode: where an algorithm's output goes, decided before it runs
 * (docs/GEOKERNEL.md §4.12).
 *
 * **Because undo does not reach geographic data.** Checkpoints deliberately
 * exclude it — a scene is too large to store every turn, so there is nothing to
 * roll back TO (§10.1 #6). That decision is sound and it has a price: the only
 * defence left against destroying a result is not destroying it in the first
 * place. OSM's writer reached the same conclusion independently and never
 * overwrites either (§6.7); this is the same rule for the other tool that
 * writes, and RunQgisAlgorithm had none at all — OUTPUT went straight to
 * Processing, which happily writes over whatever is there.
 *
 * **It re-points, it does not refuse.** §4.12 is emphatic that a check against
 * catalog metadata only ever ADVISES, because the metadata cannot express every
 * constraint and blocking on its gaps turns them into "the user cannot run
 * this". Re-pointing is a stronger act than advising, so it is fenced twice
 * over: the parameter must be a destination ACCORDING TO THE CATALOG, and its
 * value must look like an absolute path. Neither alone is enough. Anything this
 * does not recognise passes through untouched and QGIS decides, as before.
 *
 * **The numbering itself is not ours.** `out.shp` becomes `out (1).shp`, and
 * the shape lives in `geo/naming.ts` because the OSM downloader owes the user
 * the same one. What this module contributes is the meaning of "taken".
 *
 * **Companions need no help.** A shapefile is five files, but OGR derives every
 * one of them from the `.shp` stem: numbering the name we hand over numbers the
 * whole family, `out (1).dbf` beside `out (1).shp`. This is the difference from
 * OSM, where the siblings are ours — `-points`, `-lines`, `-polygons` are
 * invented by that module, so it has to look for them itself (§6.7). --- */

/**
 * The six parameter types QGIS uses for something the algorithm writes.
 *
 * Taken from `param.type()`, which the catalog already stores — no new export,
 * no rebuild. Measured against a real 3.44 registry across the three providers
 * we admit: 432 destination parameters, and **not one non-destination parameter
 * anywhere answers with any of these six strings**. That is what makes a name
 * comparison sound enough to re-point a path on.
 */
const DESTINATION_TYPES = new Set([
  "sink",
  "rasterDestination",
  "fileDestination",
  "vectorDestination",
  "folderDestination",
  "vectorTileDestination",
])

/**
 * The one destination that is a directory rather than a file.
 *
 * Eight algorithms, all of them producing a set whose size is not known in
 * advance — a layer split by attribute, a tile pyramid, a batch export. For
 * those, an existing directory is the ORDINARY case: the user means "put it in
 * here". Numbering it would answer a correct call by inventing `output (1)/`
 * and leaving the files somewhere they did not ask for.
 */
const FOLDER_TYPE = "folderDestination"

export interface Reservation {
  /** The parameter name as the algorithm spells it. */
  readonly parameter: string
  /** The path the caller asked for. */
  readonly asked: string
  /** The path that will be written. Differs from `asked` only when it was taken. */
  readonly actual: string
  /** A directory destination: never numbered, and permission is asked for the directory itself. */
  readonly folder: boolean
}

/**
 * The first free name at or after the requested one (`geo/naming.ts`).
 *
 * Only the name handed to QGIS is considered. A shapefile's `.dbf` and `.shx`
 * follow the stem it is given, so they move with it; a stale companion left
 * beside a deleted `.shp` is already broken data and gets rewritten, which
 * costs nothing that was not already lost.
 */
export function free(requested: string): string {
  return GeoNaming.firstFree(
    requested,
    existsSync,
    `${GeoNaming.MAX_ATTEMPTS} numbered names beside ${requested} are all taken; clear some before running this again`,
  )
}

/**
 * What this call will write, and where it will really land.
 *
 * Returns an entry for every destination it recognises, whether or not the path
 * moved — the caller needs the unmoved ones too, to ask permission for them and
 * to make their parent directory. `actual === asked` says nothing moved.
 *
 * An unknown algorithm yields nothing at all: without catalog metadata there is
 * no way to tell a destination from any other string, and guessing would
 * re-point a parameter that was never an output.
 */
export function reserve(algorithm: Algorithm | undefined, parameters: Record<string, unknown>): Reservation[] {
  if (!algorithm) return []
  const reservations: Reservation[] = []
  for (const parameter of algorithm.parameters) {
    if (!DESTINATION_TYPES.has(parameter.type)) continue
    const value = parameters[parameter.name]
    // A destination is very often NOT a path: `TEMPORARY_OUTPUT`, `memory:`,
    // and an omitted parameter are all ordinary and all mean "QGIS decides".
    // Requiring an absolute path is what keeps this away from them.
    if (typeof value !== "string" || !path.isAbsolute(value)) continue
    const folder = parameter.type === FOLDER_TYPE
    reservations.push({
      parameter: parameter.name,
      asked: value,
      actual: folder ? value : free(value),
      folder,
    })
  }
  return reservations
}

/** The parameters as they should be sent, with every moved destination replaced. */
export function apply(
  parameters: Record<string, unknown>,
  reservations: readonly Reservation[],
): Record<string, unknown> {
  const moved = reservations.filter((reservation) => reservation.actual !== reservation.asked)
  if (moved.length === 0) return parameters
  const next = { ...parameters }
  for (const reservation of moved) next[reservation.parameter] = reservation.actual
  return next
}

/**
 * Make the directory an output is going into, if it is not there yet.
 *
 * Upstream's `write` tool does the same for the same reason (`writeWithDirs`):
 * a missing parent is a typo's worth of work to fix and refusing it teaches
 * nothing. Best effort — a path that cannot be created will fail inside QGIS
 * with a message about the real problem, which is where §4.12 wants it.
 */
export function ensureParents(reservations: readonly Reservation[]): void {
  for (const reservation of reservations) {
    // For a folder destination the algorithm creates the leaf itself; what has
    // to exist either way is the directory it sits in.
    const parent = path.dirname(reservation.actual)
    try {
      mkdirSync(parent, { recursive: true })
    } catch {
      // Deliberately silent: see above.
    }
  }
}

/**
 * The line that tells the caller where its data actually is.
 *
 * Only the paths that MOVED. An output that landed where it was asked for is
 * something the caller already knows, and a note that fires on every run is the
 * kind of noise that gets the whole channel skipped (the same reasoning §6.4
 * applies to a warning that is always true).
 */
export function report(reservations: readonly Reservation[]): string | undefined {
  const moved = reservations.filter((reservation) => reservation.actual !== reservation.asked)
  if (moved.length === 0) return undefined
  return moved
    .map(
      (reservation) =>
        `${reservation.parameter} written to ${reservation.actual} — ${reservation.asked} already existed and is untouched.`,
    )
    .join("\n")
}
