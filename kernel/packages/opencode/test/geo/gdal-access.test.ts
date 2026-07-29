import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { GdalAccess } from "@/geo/gdal/access"

/* The data face's precondition (docs/GEOKERNEL.md §7.8).
 *
 * These endpoints are the only surface in the kernel that takes a path from
 * outside, so this check is not hardening — it is the thing that makes them
 * safe to expose at all.
 *
 * The cases below are built out of REAL symlinks rather than crafted strings,
 * because the failure this guards against is precisely the one strings cannot
 * see: a name that stays inside the project while the bytes come from outside
 * it. A string-containment check passes every one of them. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-access-"))
const project = path.join(root, "project")
const outside = path.join(root, "elsewhere")
fs.mkdirSync(path.join(project, "data"), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (file: string, content = "x") => {
  fs.writeFileSync(file, content)
  return file
}

const boundary = { directory: project, worktree: project }

write(path.join(project, "data", "dem.tif"))
write(path.join(outside, "secrets.tif"))

describe("gdal path boundary", () => {
  test("a file inside the project resolves to itself", () => {
    const resolved = GdalAccess.resolve(boundary, "data/dem.tif")
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.file).toBe(fs.realpathSync(path.join(project, "data", "dem.tif")))
  })

  test("climbing out with .. is refused", () => {
    expect(GdalAccess.resolve(boundary, "../elsewhere/secrets.tif")).toEqual({ ok: false, reason: "escapes" })
  })

  test("an absolute path outside is refused, not quietly reinterpreted", () => {
    // Joining it onto the project instead — which is what `path.join` does —
    // would turn this into a plausible project path and answer "no such file",
    // hiding a refusal behind an unrelated fact.
    const target = path.join(outside, "secrets.tif")
    expect(GdalAccess.resolve(boundary, target)).toEqual({ ok: false, reason: "escapes" })
  })

  test("a symlink that leaves the project is refused", () => {
    // THE case this file exists for. The name is inside the project the whole
    // way, and only resolving it reveals where the bytes come from.
    const link = path.join(project, "data", "linked.tif")
    fs.symlinkSync(path.join(outside, "secrets.tif"), link)
    expect(GdalAccess.resolve(boundary, "data/linked.tif")).toEqual({ ok: false, reason: "escapes" })
  })

  test("a symlink that stays inside is allowed", () => {
    // The check is about where a path leads, not about symlinks being suspect.
    const link = path.join(project, "data", "alias.tif")
    fs.symlinkSync(path.join(project, "data", "dem.tif"), link)
    expect(GdalAccess.resolve(boundary, "data/alias.tif").ok).toBe(true)
  })

  test("nothing there is missing, not an escape", () => {
    // Different facts, and telling the caller the wrong one sends them looking
    // for a typo that is not there — or reports a fault where there was none.
    expect(GdalAccess.resolve(boundary, "data/absent.tif")).toEqual({ ok: false, reason: "missing" })
  })
})

describe("gdal path boundary, datasets of several files", () => {
  test("a shapefile whose attribute table points outside is refused", () => {
    // The geometry, the attributes and the coordinate system live in different
    // files, and the caller only ever names one of them. Checking that one
    // would let the attributes come from anywhere on the machine.
    write(path.join(outside, "leaked.dbf"))
    write(path.join(project, "data", "layer.shp"))
    fs.symlinkSync(path.join(outside, "leaked.dbf"), path.join(project, "data", "layer.dbf"))
    expect(GdalAccess.resolve(boundary, "data/layer.shp")).toEqual({ ok: false, reason: "escapes" })
  })

  test("companions that are simply absent are no obstacle", () => {
    // Plenty of real shapefiles carry no `.cpg`, and refusing those would be
    // refusing ordinary data.
    write(path.join(project, "data", "plain.shp"))
    write(path.join(project, "data", "plain.dbf"))
    expect(GdalAccess.resolve(boundary, "data/plain.shp").ok).toBe(true)
  })
})

describe("gdal path boundary, projects with a worktree", () => {
  test("a file in the worktree but outside the working directory is allowed", () => {
    // A git worktree can sit beside the working directory and still belong to
    // the project — the same pair the host kernel's own check uses.
    const worktree = path.join(root, "worktree")
    fs.mkdirSync(worktree, { recursive: true })
    write(path.join(worktree, "dem.tif"))
    const pair = { directory: path.join(project, "data"), worktree }
    expect(GdalAccess.resolve(pair, path.join(worktree, "dem.tif")).ok).toBe(true)
  })

  test("a project reporting / as its worktree does not thereby contain the machine", () => {
    // Non-git projects report "/", which would contain every absolute path
    // there is. That is not a boundary, so it is not used as one.
    const everywhere = { directory: path.join(project, "data"), worktree: "/" }
    expect(GdalAccess.resolve(everywhere, path.join(outside, "secrets.tif"))).toEqual({
      ok: false,
      reason: "escapes",
    })
  })
})
