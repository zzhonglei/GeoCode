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
  // --- GeoCode: no tmp/temp rules, because GIS tools write intermediate outputs there that the watcher must
  // report; keep them out when a merge brings them back. ---
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
]

/* --- GeoCode: SQLite journals and QGIS backups, locks and autosaves rewrite constantly and would flood the watcher;
 * kept out of `FILES` so `match` is unaffected (docs/GEOKERNEL.md §10.1 #7). --- */
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
