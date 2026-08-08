export * as OsmOutput from "./output"

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { OsmConvert } from "./convert"

/* --- GeoCode: writing results to disk (docs/GEOKERNEL.md §6.7).
 *
 * Two rules, both about what the NEXT reader of the directory will believe.
 *
 * A mixed-geometry file is a hazard downstream — GIS tools work a family at a
 * time and format conversion refuses it outright — so results with more than
 * one family are split into single-family siblings.
 *
 * And **nothing here ever overwrites an existing file**. A download is minutes
 * of somebody's time and a public service's, and the same path gets asked for
 * again all the time: to refresh, to add a field that was dropped, to retry
 * what came back short. When a name is taken the run numbers itself instead,
 * the way a browser does.
 *
 * That replaces a conditional protection that used to sit above this module —
 * "do not write an empty result over a good one when something failed" — and
 * it is a better trade than tuning that condition was. A condition has to be
 * right about every way a run can end, and it was not: cancellation left no
 * failure behind, so a cancelled run wrote an empty collection over a
 * finished download. Not overwriting removes the question rather than
 * answering it (§12).
 *
 * The cost is real and belongs in the open: repeated runs accumulate files,
 * and geographic data is large. The user's disk fills with their own history
 * rather than losing it. --- */

const FAMILIES: OsmConvert.Family[] = ["points", "lines", "polygons"]

/** Enough that reaching it means something is wrong, not that someone was busy. */
const MAX_ATTEMPTS = 10_000

export interface Written {
  readonly path: string
  readonly count: number
  readonly family: string
}

/**
 * The path a caller asked for, made safe to derive sibling names from.
 *
 * What we write is GeoJSON, so a path that does not say so gets told to. This
 * is not cosmetic: the sibling names below are built by inserting the family
 * before the extension, and a base with no recognizable extension would produce
 * a sibling identical to the base itself.
 */
function normalizeBase(base: string): string {
  const extension = path.extname(base).toLowerCase()
  return extension === ".geojson" || extension === ".json" ? base : `${base}.geojson`
}

function siblingPath(base: string, family: OsmConvert.Family): string {
  const extension = path.extname(base)
  return path.join(path.dirname(base), `${path.basename(base, extension)}-${family}${extension}`)
}

/**
 * Whether a base name is spoken for.
 *
 * The siblings count, not just the base. Whether this run splits is not known
 * until its features have been grouped, so a base whose `-points` sibling
 * already exists is taken even when nothing sits at the base itself —
 * otherwise a splitting run would land on top of an earlier splitting run.
 */
function taken(base: string): boolean {
  return existsSync(base) || FAMILIES.some((family) => existsSync(siblingPath(base, family)))
}

/**
 * The first free name at or after the requested one: `x.geojson`, then
 * `x-1.geojson`, `x-2.geojson`.
 *
 * The number goes on the BASE, so a split run's files share it and stay
 * legible as one run: `x-1-points.geojson`, `x-1-lines.geojson`.
 */
export function free(requested: string): string {
  const base = normalizeBase(requested)
  if (!taken(base)) return base
  const extension = path.extname(base)
  const stem = path.join(path.dirname(base), path.basename(base, extension))
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = `${stem}-${attempt}${extension}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`${MAX_ATTEMPTS} numbered names beside ${base} are all taken; clear some before downloading again`)
}

export function write(
  requested: string,
  features: readonly OsmConvert.Feature[],
): { outputs: Written[]; bytes: number } {
  mkdirSync(path.dirname(normalizeBase(requested)), { recursive: true })
  const base = free(requested)
  const groups = OsmConvert.splitByFamily(features)
  const outputs: Written[] = []

  if (groups.size <= 1) {
    writeFileSync(base, OsmConvert.toFeatureCollection(features), "utf-8")
    outputs.push({
      path: base,
      count: features.length,
      family: groups.size === 1 ? [...groups.keys()][0]! : "empty",
    })
  } else {
    // The cleanup pass that used to sit here — deleting the siblings a run did
    // not produce, so a directory held exactly one run's files — is gone. Not
    // because it had become dangerous: it keyed on the base, and the base is
    // now numbered, so it could only ever have removed this run's own names.
    // It is gone because it had become pointless, and a reader would have
    // spent time working out whether it still mattered.
    for (const family of FAMILIES) {
      const group = groups.get(family)
      if (!group || group.length === 0) continue
      const target = siblingPath(base, family)
      writeFileSync(target, OsmConvert.toFeatureCollection(group), "utf-8")
      outputs.push({ path: target, count: group.length, family })
    }
  }

  const bytes = outputs.reduce((sum, entry) => sum + statSync(entry.path).size, 0)
  return { outputs, bytes }
}
