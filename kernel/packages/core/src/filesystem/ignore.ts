import { Glob } from "../util/glob"
// GeoCode: the shared GIS taxonomy (docs/GEOKERNEL.md §10.1 #5, #7).
import { GeoExtensions } from "./geo-extensions"

const FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
])

const FILES = [
  "**/*.swp",
  "**/*.swo",
  "**/*.pyc",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/logs/**",
  // --- GeoCode-MERGE: tmp/temp deliberately NOT ignored — GIS workflows write
  // intermediate outputs there, and a user who has just produced one expects to
  // see it. Boundary marker so a future upstream re-add of a tmp/temp ignore
  // rule trips a merge conflict instead of silently restoring it. ---
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
]

/* --- GeoCode: transient files GIS tools churn constantly (docs/GEOKERNEL.md §10.1 #7).
 *
 * SQLite WAL / SHM / journal companions (GeoPackage, SpatiaLite, Esri mobile geodatabase, plain `.db`), plus
 * QGIS project and style backups, locks and autosaves: a single QGIS session rewrites these hundreds of times,
 * and every rewrite would otherwise reach the watcher as a file change.
 *
 * The suffixes come from the shared taxonomy, which keeps them from drifting away from the snapshot exclude,
 * and out of `FILES` on purpose: the scope is the watcher, not `match`, which answers a different question. --- */
export const GEOCODE_WATCHER_IGNORE_PATTERNS = GeoExtensions.TRANSIENT_SUFFIXES.map((suffix) => `**/*.${suffix}`)

export const PATTERNS = [...FILES, ...FOLDERS, ...GEOCODE_WATCHER_IGNORE_PATTERNS]

export function match(filepath: string, opts?: { extra?: string[]; whitelist?: string[] }) {
  for (const pattern of opts?.whitelist || []) {
    if (Glob.match(pattern, filepath)) return false
  }

  const parts = filepath.split(/[/\\]/)
  for (const part of parts) {
    if (FOLDERS.has(part)) return true
  }

  for (const pattern of [...FILES, ...(opts?.extra || [])]) {
    if (Glob.match(pattern, filepath)) return true
  }

  return false
}

export * as Ignore from "./ignore"
