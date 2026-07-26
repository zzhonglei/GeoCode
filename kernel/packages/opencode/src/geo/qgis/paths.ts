export * as QgisPaths from "./paths"

import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

/* --- GeoCode: path helpers shared by both platforms' resolution
 * (docs/GEOKERNEL.md §4.3–§4.5). --- */

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

/**
 * Does this directory hold the projection database?
 *
 * The check that makes §4.3 principle 4 concrete: a directory existing proves
 * nothing, and a projection directory without its database is exactly the
 * failure that surfaces much later, when a user first touches a custom
 * coordinate system.
 */
export function hasProjectionDatabase(directory: string): boolean {
  return existsSync(path.join(directory, "proj.db"))
}

/**
 * Walk the segments of a path left to right, offering each prefix.
 *
 * A pure string scan: the number of filesystem calls is proportional to how
 * many segments MATCH, not to how deep the path is. Left to right rather than
 * from the leaf upwards, so a nested layout resolves to the outermost install
 * that qualifies rather than to a container directory that merely looks like
 * one.
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
