export * as GdalAccess from "./access"

import { realpathSync } from "node:fs"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"

/* --- GeoCode: what the data face is allowed to open (docs/GEOKERNEL.md §7.8).
 *
 * The preview endpoints are the only surface in the kernel that takes a path
 * from outside, which makes this check their precondition rather than a
 * hardening measure. Everything else in GeoKernel opens files the user named in
 * their own configuration.
 *
 * **String containment is not enough, and that is the whole reason this file
 * exists.** A symlink inside the project can point anywhere on the machine; the
 * name stays inside the boundary while the bytes come from outside it. So every
 * path is resolved to what it actually refers to — the boundary as well as the
 * target — and compared afterwards. A dataset spread across several files gets
 * the same treatment for each of them, since a shapefile whose attribute table
 * is a symlink is exactly the same escape wearing a different name. --- */

/**
 * The project a request is allowed to read from.
 *
 * Two paths rather than one because a git worktree may sit outside the working
 * directory while still belonging to the project — the same pair the host
 * kernel's own boundary check uses.
 */
export interface Boundary {
  readonly directory: string
  readonly worktree: string
}

export type Resolved =
  | { readonly ok: true; readonly file: string }
  /** The path resolves outside the project — including via a symlink. */
  | { readonly ok: false; readonly reason: "escapes" }
  /** Nothing is there, so there is nothing to resolve or to serve. */
  | { readonly ok: false; readonly reason: "missing" }

/**
 * Companions that carry part of a dataset, and must be inside the boundary too.
 *
 * Deliberately the same list the cache keys on: those are the files whose
 * content reaches the caller, so those are the files whose location matters.
 */
const SIDECARS = [".dbf", ".shx", ".prj", ".cpg"] as const

/** What a path actually refers to, or undefined when it refers to nothing. */
function real(file: string): string | undefined {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}

function inside(boundary: { directory: string; worktree?: string }, file: string): boolean {
  if (FSUtil.contains(boundary.directory, file)) return true
  // A non-git project reports "/" as its worktree, which would contain every
  // absolute path on the machine — that is not a boundary, so it is not used.
  if (!boundary.worktree || boundary.worktree === "/") return false
  return FSUtil.contains(boundary.worktree, file)
}

/**
 * Turn a caller's path into a file this request may open.
 *
 * Relative paths are read against the project; absolute ones are taken as given
 * and then judged like anything else. Joining an absolute path onto the project
 * instead — which is what `path.join` does — would turn `/etc/passwd` into a
 * plausible-looking project path and report "no such file", hiding a refusal
 * behind an unrelated answer.
 */
export function resolve(boundary: Boundary, requested: string): Resolved {
  const directory = real(boundary.directory)
  if (!directory) return { ok: false, reason: "missing" }
  const worktree = real(boundary.worktree)

  const file = real(path.resolve(boundary.directory, requested))
  if (!file) return { ok: false, reason: "missing" }
  if (!inside({ directory, worktree }, file)) return { ok: false, reason: "escapes" }

  // A companion that is absent is fine — plenty of shapefiles carry no `.cpg`.
  // One that exists and points outside is not, and checking only the file that
  // was named would let the attribute table come from anywhere.
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
