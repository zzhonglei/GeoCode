export * as QgisDestination from "./destination"

import { existsSync, mkdirSync, readdirSync } from "node:fs"
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
 * invented by that module, so it has to look for them itself (§6.7).
 *
 * **"Taken" is not the same as "already exists".** QGIS does not always write
 * the path it is handed, and it does not always own the answer either. Both
 * departures are measured, both are below, and both were found by asking a real
 * 3.44 registry rather than by reasoning about what ought to happen. --- */

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

/* --- There is deliberately NO exemption for "algorithms that manage a
 * pre-existing file themselves", and it must not be added back.
 *
 * There used to be one: a measured set of two parameter names
 * (`ACTION_ON_EXISTING_FILE`, `OVERWRITE`) whose presence made `reserve` leave
 * the path alone, on the reasoning that for `native:package` and
 * `native:savefeatures` an existing target is the POINT of the call — appending
 * a layer to a GeoPackage, adding a sheet to a spreadsheet — and numbering it
 * would append to a brand new empty file and report success.
 *
 * Removed 2026-08-20 for two reasons, measured on a real 3.44 registry:
 *
 * 1. **It read the wrong thing.** It tested whether the PARAMETER EXISTS, never
 *    what the call SET IT TO — and the defaults run the other way:
 *    `native:savefeatures` defaults `ACTION_ON_EXISTING_FILE` to 0, "Create or
 *    overwrite file", and `native:exporttospreadsheet` defaults `OVERWRITE` to
 *    True. So a call that named an existing .gpkg and left the parameter alone
 *    got its numbering waived and its file overwritten — the exemption stood
 *    aside for exactly the case it was meant to catch.
 * 2. **A name list cannot survive the user's QGIS.** The catalog is built from
 *    whichever version they installed; two names measured here describe this
 *    machine. Every structural alternative was probed and each one failed:
 *    `supports_append` is a property of the sink TYPE and matches 83 algorithms,
 *    `widget_wrapper.dontconfirmoverwrite` matches only 2 of the 3 (and is a GUI
 *    hint besides), and a keyword test on the name matches `GEOREFERENCE` and
 *    `gdal:proximity`'s `REPLACE`, neither of which has anything to do with an
 *    existing file.
 *
 * What settles it is that the two failures are not the same size. Numbering an
 * append writes the new data BESIDE the old: the user's file is intact and the
 * result is recoverable by hand. Waiving the numbering lets an overwrite land
 * on data that checkpoints do not hold (§10.1 #6) — gone, with nothing to
 * restore from. ⟹ When the two cannot be told apart reliably, take the
 * recoverable failure. `report()` names the new path, and says in as many words
 * that it is not an addition to the old file, so an append that was meant to
 * happen is visible rather than silent. --- */

export interface Reservation {
  /** The parameter name as the algorithm spells it. */
  readonly parameter: string
  /** The path the caller asked for. */
  readonly asked: string
  /** The path that will be written. Differs from `asked` only when it was taken. */
  readonly actual: string
  /** A directory destination: never numbered, so this is the one kind of output that can land on something already there. */
  readonly folder: boolean
  /** Where the output really is, once the run is over (`settle`). Absent until then, and absent when it landed exactly where it was sent. */
  readonly landed?: string
}

/**
 * Every name a directory already answers to, including the names QGIS would
 * grow into one of them.
 *
 * This used to be a plain `existsSync` on the literal string, and that misses
 * the case the whole module exists for. Given a path whose extension it does
 * not recognise — including none at all — QGIS appends its own. Measured on
 * 3.44:
 *
 * ```
 * native:buffer   OUTPUT=/tmp/vfy2/noext        wrote  noext.gpkg
 * native:buffer   OUTPUT=/tmp/vfy2/weird.xyz    wrote  weird.xyz.gpkg
 * gdal:translate  OUTPUT=/tmp/vfy2/rnoext       wrote  nothing: "Output format is invalid"
 * gdal:translate  OUTPUT=/tmp/vfy2/rweird.xyz   wrote  rweird.xyz          (the literal name)
 * ```
 *
 * So on the vector side `noext` had to count as taken by `noext.gpkg`, or the
 * numbering never fires and the previous run is overwritten — the one outcome
 * this module was built to prevent. (The raster side needs no help: it either
 * writes the literal name or refuses, and §4.12 wants that refusal coming from
 * QGIS.) Recording every dot-prefix covers both, without this module having to
 * predict which driver QGIS will pick.
 *
 * It errs toward numbering: a `report.txt` sitting beside a requested `report`
 * marks the name taken even though QGIS would have written `report.gpkg`. That
 * costs one numbered name. The error in the other direction costs a scene that
 * undo cannot bring back, so the asymmetry is deliberate.
 */
function occupants(directory: string): Set<string> {
  const names = new Set<string>()
  let entries: readonly string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // No directory yet, or one we cannot list. Nothing there is in the way,
    // and `ensureParents` is what makes the missing case ordinary.
    return names
  }
  for (const entry of entries) {
    names.add(entry)
    // From index 1, so a dotfile is a name and not an extension on nothing.
    for (let dot = entry.indexOf(".", 1); dot > 0; dot = entry.indexOf(".", dot + 1)) {
      names.add(entry.slice(0, dot))
    }
  }
  return names
}

/**
 * The first free name at or after the requested one (`geo/naming.ts`).
 *
 * Only the name handed to QGIS is considered. A shapefile's `.dbf` and `.shx`
 * follow the stem it is given, so they move with it; a stale companion left
 * beside a deleted `.shp` is already broken data and gets rewritten, which
 * costs nothing that was not already lost.
 *
 * `taken` holds bare file names, not paths. Passing one lets a caller add to it
 * between calls, which is how a name issued earlier in the same run blocks a
 * later one (`reserve`); leaving it out reads the directory for this call
 * alone.
 */
export function free(requested: string, taken?: ReadonlySet<string>): string {
  const occupied = taken ?? occupants(path.dirname(requested))
  return GeoNaming.firstFree(
    requested,
    (candidate) => occupied.has(path.basename(candidate)),
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
  // One listing per directory, shared by every destination that writes there —
  // and then added to, so that a name this call has already issued is taken for
  // the rest of it. Two outputs of one algorithm landing on one path is the
  // same overwrite as any other, just arranged by us instead of the caller:
  // OUTPUT moved to "out (1).shp" is no help if SIDECAR was asked for exactly
  // that, and the report would call the collision a rescue.
  const listings = new Map<string, Set<string>>()
  for (const parameter of algorithm.parameters) {
    if (!DESTINATION_TYPES.has(parameter.type)) continue
    const value = parameters[parameter.name]
    // A destination is very often NOT a path: `TEMPORARY_OUTPUT`, `memory:`,
    // and an omitted parameter are all ordinary and all mean "QGIS decides".
    // Requiring an absolute path is what keeps this away from them.
    if (typeof value !== "string" || !path.isAbsolute(value)) continue
    const directory = path.dirname(value)
    let taken = listings.get(directory)
    if (!taken) {
      taken = occupants(directory)
      listings.set(directory, taken)
    }
    const folder = parameter.type === FOLDER_TYPE
    // One reason left to leave a path alone, and it is about what the path
    // MEANS rather than about the algorithm: a folder destination says "put the
    // results in here", so an existing directory is the ordinary case and
    // numbering it would invent `output (1)/` for a perfectly correct call.
    // Everything else is numbered — see the note above on why there is no
    // exemption for algorithms that claim to manage the target themselves.
    const actual = folder ? value : free(value, taken)
    taken.add(path.basename(actual))
    reservations.push({ parameter: parameter.name, asked: value, actual, folder })
  }
  return reservations
}

/**
 * The reservations again, with `landed` filled in for anything QGIS renamed.
 *
 * Run after the algorithm and only when it succeeded. Numbering keeps the data
 * safe on its own, but the report and `metadata.destinations` still have to
 * name a file that is there: an OUTPUT of `/data/result` is written as
 * `/data/result.gpkg`, and a caller told to "use that path for the next step"
 * cannot use the one it was given.
 *
 * Only when exactly one candidate grew out of the name. Several means the
 * driver wrote a family — or left a sidecar — and picking one of them would be
 * a guess; `actual` is at least what we asked for, which is honest about being
 * incomplete rather than confidently wrong.
 */
export function settle(reservations: readonly Reservation[]): Reservation[] {
  return reservations.map((reservation) => {
    if (reservation.folder || existsSync(reservation.actual)) return reservation
    const directory = path.dirname(reservation.actual)
    const stem = path.basename(reservation.actual) + "."
    let entries: readonly string[]
    try {
      entries = readdirSync(directory)
    } catch {
      return reservation
    }
    const grown = entries.filter((entry) => entry.startsWith(stem))
    if (grown.length !== 1) return reservation
    return { ...reservation, landed: path.join(directory, grown[0]!) }
  })
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
 * The lines that tell the caller where its data actually is — and, where this
 * module stood aside, that it did.
 *
 * Nothing is said about an output that landed exactly where it was asked for:
 * the caller already knows that, and a note firing on every run is the kind of
 * noise that gets the whole channel skipped. Two things are worth a line
 * because neither can be inferred from the call:
 *
 * - it was numbered, so the next step needs a path nobody typed;
 * - QGIS named the file itself, same consequence.
 *
 * The numbered line carries a second sentence, and it is load-bearing. With the
 * governed-destination exemption gone (see the note at the top of this module),
 * a call that MEANT to append — a layer into a GeoPackage, a sheet into a
 * spreadsheet — now gets a new file beside the old one instead. That is the
 * recoverable half of an unavoidable trade, but only if the caller can tell it
 * happened: "already existed and is untouched" on its own reads as pure good
 * news, and an append that silently went somewhere else is exactly what §6.3
 * rates worse than a failure. So the line says what the new file is NOT.
 */
export function report(reservations: readonly Reservation[]): string | undefined {
  const lines: string[] = []
  for (const reservation of reservations) {
    const at = reservation.landed ?? reservation.actual
    if (reservation.actual !== reservation.asked) {
      lines.push(
        `${reservation.parameter} written to ${at} — ${reservation.asked} already existed and is untouched.` +
          ` This is a new file, not an addition to that one: if this call was meant to add to it, delete` +
          ` ${at} and run again once you have checked what is in the way.`,
      )
      continue
    }
    if (reservation.landed) {
      lines.push(`${reservation.parameter} written to ${at} — QGIS chose the format and named the file.`)
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}
