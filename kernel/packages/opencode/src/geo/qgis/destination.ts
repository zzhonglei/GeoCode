export * as QgisDestination from "./destination"

import { existsSync, mkdirSync, readdirSync } from "node:fs"
import path from "node:path"
import { GeoNaming } from "../naming"
import type { Algorithm } from "./catalog"

/* --- GeoCode: where an algorithm's output goes, decided before it runs (docs/GEOKERNEL.md §4.12).
 *
 * A taken name is numbered through `geo/naming.ts` rather than refused — undo does not reach geographic data (§10.1
 * #6) — and the numbering yields to a folder destination and to no algorithm whatever its parameters say (§4.12).
 * Re-pointing is fenced twice: the catalog must call the parameter a destination AND its value must be an absolute
 * path, and anything else passes through untouched for QGIS to decide. --- */

/**
 * `param.type()` for the six things an algorithm writes, which the catalog already stores. Measured on a 3.44
 * registry across the three providers we admit: 432 destination parameters, and no non-destination parameter
 * answers with any of these six strings — which is what makes comparing a name sound enough to re-point a path on.
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
 * The one destination that is a directory rather than a file, on 8 algorithms of a 3.44 registry. Never numbered: it
 * means "put the results in here", so an existing directory is the ordinary case and numbering a correct call would
 * invent `output (1)/`.
 */
const FOLDER_TYPE = "folderDestination"

export interface Reservation {
  /** The parameter name as the algorithm spells it. */
  readonly parameter: string
  /** The path the caller asked for. */
  readonly asked: string
  /** The path QGIS is handed. Differs from `asked` only when `asked` was taken. */
  readonly actual: string
  /** A directory destination, and so the one kind of output that can land on something already there. */
  readonly folder: boolean
  /** Filled in by `settle` when QGIS named the file itself; absent otherwise. */
  readonly landed?: string
}

/**
 * Every name the directory answers to, dot-prefixes included: QGIS appends its own extension to a destination whose
 * extension it does not recognise (3.44: `native:buffer` with `OUTPUT=/x/noext` writes `noext.gpkg`), so `noext` has
 * to count as taken by an existing `noext.gpkg` or the previous run is overwritten. Erring toward numbering — a
 * `report.txt` marks a requested `report` taken — costs a name rather than a scene.
 */
function occupants(directory: string): Set<string> {
  const names = new Set<string>()
  let entries: readonly string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // A directory that is not there yet holds nothing in the way; `ensureParents` creates it before QGIS runs.
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
 * The first free name at or after the requested one (`geo/naming.ts`). Only the name handed to QGIS is considered,
 * since OGR derives a shapefile's companions from the `.shp` stem and they move with it. `taken` holds bare file
 * names, not paths; passing one is how a name issued earlier in the same run blocks a later one (`reserve`).
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
 * What this call will write, and where. An entry for every destination it recognises, moved or not — the caller
 * needs the unmoved ones too, for `ensureParents` and the `destinations` metadata. An unknown algorithm yields
 * nothing: without catalog metadata a destination cannot be told from any other string, and a guess re-points a
 * parameter that was never an output.
 */
export function reserve(algorithm: Algorithm | undefined, parameters: Record<string, unknown>): Reservation[] {
  if (!algorithm) return []
  const reservations: Reservation[] = []
  // One listing per directory, added to as names are issued: OUTPUT moved to "out (1).shp" is no help if SIDECAR was
  // asked for exactly that, and the report would call the collision a rescue.
  const listings = new Map<string, Set<string>>()
  for (const parameter of algorithm.parameters) {
    if (!DESTINATION_TYPES.has(parameter.type)) continue
    const value = parameters[parameter.name]
    // A destination is very often not a path: `TEMPORARY_OUTPUT`, `memory:` and an omitted parameter are all
    // ordinary and all mean "QGIS decides", and requiring an absolute path is what keeps this away from them.
    if (typeof value !== "string" || !path.isAbsolute(value)) continue
    const directory = path.dirname(value)
    let taken = listings.get(directory)
    if (!taken) {
      taken = occupants(directory)
      listings.set(directory, taken)
    }
    const folder = parameter.type === FOLDER_TYPE
    // The kind of path is the only exemption; no parameter an algorithm declares earns one (§4.12).
    const actual = folder ? value : free(value, taken)
    taken.add(path.basename(actual))
    reservations.push({ parameter: parameter.name, asked: value, actual, folder })
  }
  return reservations
}

/**
 * The reservations again, with `landed` filled in for anything QGIS named for itself: the report and the
 * `destinations` metadata have to name a file that is there, and an OUTPUT of `/data/result` is written as
 * `/data/result.gpkg`. Only when exactly one candidate grew out of the name, several being a family or a sidecar.
 * Call it only after a run that succeeded; a failed one wrote nothing to resolve against.
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
 * Make the directory an output is going into, the way upstream's `write` tool does (`writeWithDirs`). Best effort: a
 * path that cannot be created fails inside QGIS with a message about the real problem, which is where §4.12 wants it.
 */
export function ensureParents(reservations: readonly Reservation[]): void {
  for (const reservation of reservations) {
    // The parent, not the leaf — a folder destination's own directory is created by the algorithm.
    const parent = path.dirname(reservation.actual)
    try {
      mkdirSync(parent, { recursive: true })
    } catch {
      // Best effort; see above.
    }
  }
}

/**
 * The two things a caller cannot infer from its own call: the output was numbered, or QGIS named the file itself.
 * Nothing is said about one that landed where it was asked for, since a note firing on every run gets the whole
 * channel skipped. The numbered line says what the new file is NOT, because a call that meant to append to the
 * target now writes beside it (§4.12) and "already existed and is untouched" alone reads as pure good news.
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
