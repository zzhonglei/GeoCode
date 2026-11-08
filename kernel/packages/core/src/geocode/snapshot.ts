export * as GeoSnapshot from "./snapshot.js"

import path from "path"
import type { RelativePath } from "../schema.js"

/** Extensions of the files that go with a dataset of the same name: shapefile parts and indexes, world files. */
const SIDECARS = new Set([
  "shx",
  "dbf",
  "prj",
  "cpg",
  "sbn",
  "sbx",
  "qix",
  "fbn",
  "fbx",
  "ain",
  "aih",
  "atx",
  "ixs",
  "mxs",
  "qmd",
  "tfw",
  "tifw",
  "wld",
  "jgw",
  "pgw",
  "gfw",
  "bpw",
  "j2w",
  "aux",
  "rrd",
])

/** Extensions of the files those sidecars go with: a large sidecar leaves its dataset's main file out too. */
const MAIN = new Set(["shp", "tif", "tiff", "img", "jpg", "jpeg", "png", "gif", "bmp", "jp2"])

/** SQLite's files beside a database, as GeoPackage, while it is open. */
const SQLITE = ["-wal", "-shm", "-journal"]

const extension = (file: string) => {
  const base = path.posix.basename(file)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? { stem: file.slice(0, file.length - base.length + dot), extension: base.slice(dot + 1) } : undefined
}

const geodatabase = (file: string) => {
  const parts = file.split("/")
  const gdb = parts.findIndex((part, index) => index < parts.length - 1 && part.toLowerCase().endsWith(".gdb"))
  return gdb === -1 ? undefined : parts.slice(0, gdb + 1).join("/")
}

/**
 * The untracked files that belong to the same dataset as an untracked file a snapshot leaves out for its size, so a
 * snapshot keeps or leaves out a dataset whole: files named as the large one with more after it (`dem.tif.aux.xml`,
 * `dem.tif.ovr`, `roads.shp.xml`, a GeoPackage's `-wal`), its sidecars by extension (`roads.shx`, `roads.dbf`,
 * `dem.tfw`), and the File Geodatabase (`.gdb` folder) it is in; and the same the other way, when the large file is
 * not the dataset's main one (a point shapefile's `.dbf`, `dem.tif.ovr`, a GeoPackage's `-wal`). Restoring part of a
 * dataset would break it: a reverted session would bring back an old `.dbf` beside a new `.shp`, or delete the small
 * files of a new one and leave its `.shp`. Other files of the same name, such as `roads.geojson` made from
 * `roads.shp`, stay in.
 */
export const companions = (oversized: Iterable<RelativePath>, candidates: readonly RelativePath[]) => {
  const large = new Set<string>(oversized)
  if (!large.size) return []
  const sidecarStems = new Set(
    [...large].flatMap((file) => {
      const named = extension(file)
      return named && SIDECARS.has(named.extension.toLowerCase()) ? [named.stem] : []
    }),
  )
  const main = (file: string) => {
    if (SQLITE.some((suffix) => large.has(file + suffix))) return true
    if ([...large].some((other) => other.startsWith(file + "."))) return true
    const named = extension(file)
    return named !== undefined && MAIN.has(named.extension.toLowerCase()) && sidecarStems.has(named.stem)
  }
  // The main files join the large ones, so their own sidecars follow below as well.
  const left = new Set<string>([...large, ...candidates.filter(main)])
  const stems = new Set<string>()
  const geodatabases = new Set<string>()
  for (const file of left) {
    const named = extension(file)
    if (named) stems.add(named.stem)
    const gdb = geodatabase(file)
    if (gdb) geodatabases.add(gdb)
  }
  const belongs = (file: string) => {
    const gdb = geodatabase(file)
    if (gdb && geodatabases.has(gdb)) return true
    if (SQLITE.some((suffix) => file.endsWith(suffix) && left.has(file.slice(0, -suffix.length)))) return true
    const named = extension(file)
    if (named && SIDECARS.has(named.extension.toLowerCase()) && stems.has(named.stem)) return true
    // The large file's whole name, then more: each shorter name ending before a dot.
    const base = path.posix.basename(file)
    const directory = file.slice(0, file.length - base.length)
    for (let dot = base.indexOf(".", 1); dot !== -1; dot = base.indexOf(".", dot + 1))
      if (left.has(directory + base.slice(0, dot))) return true
    return false
  }
  return candidates.filter((file) => !large.has(file) && (left.has(file) || belongs(file)))
}
