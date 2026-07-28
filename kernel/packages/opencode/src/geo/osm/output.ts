export * as OsmOutput from "./output"

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { OsmConvert } from "./convert"

/* --- GeoCode: writing results to disk (docs/GEOKERNEL.md §6.7).
 *
 * Two rules, both about what the NEXT reader of the directory will believe.
 * A mixed-geometry file is a hazard downstream — GIS tools work a family at a
 * time and format conversion refuses it outright — so results with more than
 * one family are split. And a re-run must leave exactly the files of that run:
 * a sibling left over from a previous run with a different family mix would be
 * read as current data, because nothing about it says otherwise. --- */

const FAMILIES: OsmConvert.Family[] = ["points", "lines", "polygons"]

export interface Written {
  readonly path: string
  readonly count: number
  readonly family: string
}

function siblingPath(base: string, family: OsmConvert.Family): string {
  return base.replace(/\.geojson$/i, `-${family}.geojson`)
}

export function write(base: string, features: readonly OsmConvert.Feature[]): { outputs: Written[]; bytes: number } {
  mkdirSync(path.dirname(base), { recursive: true })
  const groups = OsmConvert.splitByFamily(features)
  const outputs: Written[] = []

  if (groups.size <= 1) {
    writeFileSync(base, OsmConvert.toFeatureCollection(features), "utf-8")
    outputs.push({
      path: base,
      count: features.length,
      family: groups.size === 1 ? [...groups.keys()][0]! : "empty",
    })
    // A previous run of the same download may have split. Those siblings
    // describe data this run did not produce.
    for (const family of FAMILIES) {
      const sibling = siblingPath(base, family)
      if (existsSync(sibling)) rmSync(sibling)
    }
  } else {
    for (const family of FAMILIES) {
      const group = groups.get(family)
      const target = siblingPath(base, family)
      if (group && group.length > 0) {
        writeFileSync(target, OsmConvert.toFeatureCollection(group), "utf-8")
        outputs.push({ path: target, count: group.length, family })
      } else if (existsSync(target)) {
        rmSync(target)
      }
    }
    // And the unsplit file from a previous single-family run is stale too.
    if (existsSync(base)) rmSync(base)
  }

  const bytes = outputs.reduce((sum, entry) => sum + statSync(entry.path).size, 0)
  return { outputs, bytes }
}
