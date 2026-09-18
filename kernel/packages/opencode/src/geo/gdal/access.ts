export * as GdalAccess from "./access"

import { realpathSync } from "node:fs"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"

/* --- GeoCode: what the data face is allowed to open (docs/GEOKERNEL.md §7.8). --- */

/** Checked as a union: the worktree is the repo root above the working directory, so it admits files it does not. */
export interface Boundary {
  readonly directory: string
  readonly worktree: string
}

export type Resolved =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly reason: "escapes" }
  /** The requested file, or the project directory, does not exist. */
  | { readonly ok: false; readonly reason: "missing" }

/** The same four the cache keys on. */
const SIDECARS = [".dbf", ".shx", ".prj", ".cpg"] as const

/** Boundary and target alike: a symlink can keep a name inside the project while its bytes come from outside. */
function real(file: string): string | undefined {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function inside(boundary: { directory: string; worktree?: string }, file: string): boolean {
  if (FSUtil.contains(boundary.directory, file)) return true
  // A non-git project reports "/", which would contain every absolute path — that is not a boundary.
  if (!boundary.worktree || boundary.worktree === "/") return false
  return FSUtil.contains(boundary.worktree, file)
}

/**
 * `path.resolve`, never `path.join`: joining an absolute path onto the project would turn `/etc/passwd` into a
 * plausible project path and answer "missing", hiding a refusal behind an unrelated fact.
 */
export function resolve(boundary: Boundary, requested: string): Resolved {
  const directory = real(boundary.directory)
  if (!directory) return { ok: false, reason: "missing" }
  const worktree = real(boundary.worktree)

  const file = real(path.resolve(boundary.directory, requested))
  if (!file) return { ok: false, reason: "missing" }
  if (!inside({ directory, worktree }, file)) return { ok: false, reason: "escapes" }

  // An absent companion is fine — plenty of shapefiles carry no `.cpg` — one that resolves outside is an escape.
  const extension = path.extname(file).toLowerCase()
  if (extension === ".shp") {
    const base = file.slice(0, file.length - extension.length)
    for (const suffix of SIDECARS) {
      const companion = real(base + suffix)
      if (companion && !inside({ directory, worktree }, companion)) return { ok: false, reason: "escapes" }
    }
  }

  return { ok: true, file }
}
