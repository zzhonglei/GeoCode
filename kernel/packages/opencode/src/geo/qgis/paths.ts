export * as QgisPaths from "./paths"

import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

/* --- GeoCode: path helpers shared by both platforms' resolution (docs/GEOKERNEL.md §4.3–§4.5). --- */

export function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

export function firstExisting(candidates: readonly (string | undefined)[]): string | undefined {
  return unique(candidates).find((candidate) => existsSync(candidate))
}

export function allExisting(candidates: readonly (string | undefined)[]): string[] {
  return unique(candidates).filter((candidate) => existsSync(candidate))
}

/** Directory entries, or nothing when the directory is unreadable. */
export function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Subdirectories of `directory`, as full paths. */
export function subdirectories(directory: string): string[] {
  return entries(directory)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
}

/** §4.3 principle 4 — validate the payload, not the container: a projection directory needs its database. */
export function hasProjectionDatabase(directory: string): boolean {
  return existsSync(path.join(directory, "proj.db"))
}

/**
 * Offer `accept` every prefix of `hint`, and answer with the first value it returns.
 *
 * Left to right, so the outermost prefix `accept` takes wins: a `.app` inside an accepted one never gets a turn.
 * The first call on an absolute path carries an empty prefix and an empty segment.
 */
export function scanSegments(hint: string, accept: (prefix: string, segment: string) => string | undefined) {
  const normalized = path.normalize(hint)
  let start = 0
  for (let index = 0; index <= normalized.length; index++) {
    if (index !== normalized.length && normalized[index] !== path.sep) continue
    const segment = normalized.slice(start, index)
    const accepted = accept(normalized.slice(0, index), segment)
    if (accepted !== undefined) return accepted
    start = index + 1
  }
  return undefined
}
