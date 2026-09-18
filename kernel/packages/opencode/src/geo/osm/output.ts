export * as OsmOutput from "./output"

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { GeoNaming } from "../naming"
import { OsmConvert } from "./convert"

/* --- GeoCode: writing results to disk, split into single-family siblings when geometry families mix, and numbered
 * rather than overwritten (docs/GEOKERNEL.md §6.7). --- */

const FAMILIES: OsmConvert.Family[] = ["points", "lines", "polygons"]

export interface Written {
  readonly path: string
  readonly count: number
  readonly family: string
}

/** Not cosmetic: `siblingPath` inserts the family before the extension, and a base without one yields `out-points`. */
function normalizeBase(base: string): string {
  const extension = path.extname(base).toLowerCase()
  return extension === ".geojson" || extension === ".json" ? base : `${base}.geojson`
}

function siblingPath(base: string, family: OsmConvert.Family): string {
  const extension = path.extname(base)
  return path.join(path.dirname(base), `${path.basename(base, extension)}-${family}${extension}`)
}

/** Siblings count too, since whether this run splits is unknown until its features are grouped. */
function taken(base: string): boolean {
  return existsSync(base) || FAMILIES.some((family) => existsSync(siblingPath(base, family)))
}

/** Numbered on the base, before the split, so one run's files share a number: `x (1)-points.geojson` and siblings. */
export function free(requested: string): string {
  const base = normalizeBase(requested)
  return GeoNaming.firstFree(
    base,
    taken,
    `${GeoNaming.MAX_ATTEMPTS} numbered names beside ${base} are all taken; clear some before downloading again`,
  )
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
