export * as QgisDestination from "./destination"

import { existsSync, mkdirSync, readdirSync } from "node:fs"
import path from "node:path"
import { GeoNaming } from "../naming"
import type { Algorithm } from "./catalog"

/* --- GeoCode: where an algorithm's output goes, decided before it runs (docs/GEOKERNEL.md §4.12). A taken name is
 * numbered rather than overwritten, because undo does not reach geographic data (§12, §10.1 #6). --- */

/** `param.type()` of every destination; no other parameter reports one of these, so re-pointing by type is sound. */
const DESTINATION_TYPES = new Set([
  "sink",
  "rasterDestination",
  "fileDestination",
  "vectorDestination",
  "folderDestination",
  "vectorTileDestination",
])

const FOLDER_TYPE = "folderDestination"

export interface Reservation {
  readonly parameter: string
  readonly asked: string
  /** Handed to QGIS; differs from `asked` only when `asked` was taken. */
  readonly actual: string
  readonly folder: boolean
  /** Set by `settle` when QGIS named the file itself. */
  readonly landed?: string
}

/**
 * Every name the directory answers to, dot-prefixes included: QGIS appends its own extension to a destination whose
 * extension it does not recognise, so `noext` must count as taken by `noext.gpkg`, at the accepted cost of
 * `report.txt` also taking `report`.
 */
function occupants(directory: string): Set<string> {
  const names = new Set<string>()
  let entries: readonly string[]
  try {
    entries = readdirSync(directory)
  } catch {
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
 * Only the name handed to QGIS is considered, since OGR derives a shapefile's companions from the `.shp` stem and
 * they move with it. `taken` holds bare file names, not paths.
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
 * An entry for every recognised destination, moved or not, since `ensureParents` and the `destinations` metadata need
 * the unmoved ones too. Without catalog metadata nothing is recognised: a guess re-points a parameter that was never
 * an output.
 */
export function reserve(algorithm: Algorithm | undefined, parameters: Record<string, unknown>): Reservation[] {
  if (!algorithm) return []
  const reservations: Reservation[] = []
  // One listing per directory, added to as names are issued, so two destinations of one call cannot collide.
  const listings = new Map<string, Set<string>>()
  for (const parameter of algorithm.parameters) {
    if (!DESTINATION_TYPES.has(parameter.type)) continue
    const value = parameters[parameter.name]
    // `TEMPORARY_OUTPUT`, `memory:` and an omitted parameter all mean "QGIS decides" and must pass through untouched.
    if (typeof value !== "string" || !path.isAbsolute(value)) continue
    const directory = path.dirname(value)
    let taken = listings.get(directory)
    if (!taken) {
      taken = occupants(directory)
      listings.set(directory, taken)
    }
    const folder = parameter.type === FOLDER_TYPE
    // Only a folder destination is exempt, since an existing directory is its ordinary target; no parameter an
    // algorithm declares, such as OVERWRITE, earns an exemption (docs/GEOKERNEL.md §12).
    const actual = folder ? value : free(value, taken)
    taken.add(path.basename(actual))
    reservations.push({ parameter: parameter.name, asked: value, actual, folder })
  }
  return reservations
}

/**
 * Fills `landed` only when exactly one `<name>.*` grew out of a missing `actual`, several being a family or a
 * sidecar. Call it only after a run that succeeded.
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

/** Best effort: a path that cannot be created fails inside QGIS with a message about the real problem. */
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
 * Silent for an output that landed where asked, since a note firing on every run gets the channel skipped. A numbered
 * one says the new file is not an addition to the original, because a call meant to append now writes beside it.
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
