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

export function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

export function subdirectories(directory: string): string[] {
  return entries(directory)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
}

export function hasProjectionDatabase(directory: string): boolean {
  return existsSync(path.join(directory, "proj.db"))
}

/**
 * The first value `accept` returns over the prefixes of `hint`, outermost first, so a `.app` inside an accepted one
 * never gets a turn. A leading separator makes the first call's prefix and segment both empty.
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
