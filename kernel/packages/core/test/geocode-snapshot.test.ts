import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Git } from "@opencode/core/git"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { initRepo } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

/** Files over this many bytes are left out, as Snapshot leaves out those over 2 MiB. */
const LIMIT = 4
const small = "x\n"
const large = "too large\n"

const setup = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const project = path.join(root.path, "project")
  yield* Effect.promise(async () => {
    await fs.mkdir(project)
    await initRepo(project)
    await Bun.write(path.join(project, "a.txt"), small)
    await $`git add . && git commit -q -m initial`.cwd(project).quiet()
  })
  const service = yield* Git.Service
  const source = yield* service.repo.discover(AbsolutePath.make(project))
  if (!source) throw new Error("Repository not found")
  const repository = yield* service.repo.create({
    worktree: source.worktree,
    gitDirectory: AbsolutePath.make(path.join(root.path, "storage")),
    seed: source,
  })
  const write = (files: Record<string, string>) =>
    Effect.promise(() =>
      Promise.all(
        Object.entries(files).map(async ([file, text]) => {
          await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true })
          await Bun.write(path.join(project, file), text)
        }),
      ),
    )
  const capture = () =>
    service.tree.capture({
      repository,
      scopes: [RelativePath.make(".")],
      ignores: source,
      maximumUntrackedFileBytes: LIMIT,
    })
  const entries = (tree: string) =>
    Effect.promise(async () =>
      (await $`git --git-dir ${root.path}/storage ls-tree -r --name-only ${tree}`.text()).split("\n").filter(Boolean),
    )
  return { service, repository, write, capture, entries }
})

describe("GeoCode: snapshots of datasets", () => {
  // Guards against a snapshot keeping the small files of a dataset whose large file it leaves out, which a reverted
  // session would then restore or delete without it.
  it.live("leave a dataset out whole with its large file", () =>
    Effect.gen(function* () {
      const { write, capture, entries } = yield* setup
      yield* write({
        "roads.shp": large,
        "roads.shx": small,
        "roads.dbf": small,
        "roads.prj": small,
        "roads.shp.xml": small,
        "roads.geojson": small,
        "dem.tif": large,
        "dem.tfw": small,
        "dem.tif.aux.xml": small,
        "SCAN.TIF": large,
        "SCAN.TFW": small,
        "sites.gpkg": large,
        "sites.gpkg-wal": small,
        "parcels.gdb/a00000009.gdbtable": large,
        "parcels.gdb/a00000009.gdbtablx": small,
        "parcels.gdb/gdb": small,
        "roadside.txt": small,
        "notes.txt": small,
      })

      // roads.geojson is a dataset of its own, made from roads.shp.
      expect(yield* entries(yield* capture())).toEqual(["a.txt", "notes.txt", "roads.geojson", "roadside.txt"])
    }),
  )

  // Guards against a snapshot keeping the main file of a dataset whose large file is one of its others, as a point
  // shapefile's attribute table often is.
  it.live("leave a dataset out whole when another of its files is the large one", () =>
    Effect.gen(function* () {
      const { write, capture, entries } = yield* setup
      yield* write({
        "roads.dbf": large,
        "roads.shp": small,
        "roads.shx": small,
        "roads.prj": small,
        "roads.shp.xml": small,
        "roads.geojson": small,
        "dem.tif.ovr": large,
        "dem.tif": small,
        "dem.tfw": small,
        "sites.gpkg-wal": large,
        "sites.gpkg": small,
        "sites.gpkg-shm": small,
        "notes.txt": small,
      })

      expect(yield* entries(yield* capture())).toEqual(["a.txt", "notes.txt", "roads.geojson"])
    }),
  )

  // Guards against reverting a session touching a dataset it rewrote or wrote, which would leave it broken.
  it.live("keep a reverted session off the datasets they leave out", () =>
    Effect.gen(function* () {
      const { service, repository, write, capture } = yield* setup
      yield* write({ "roads.shp": large, "roads.shx": small, "roads.dbf": small, "notes.txt": small })
      const before = yield* capture()
      // As a geo tool rewrites one dataset and writes another, and the user edits a note.
      yield* write({
        "roads.shp": large + large,
        "roads.shx": "y\n",
        "roads.dbf": "y\n",
        "rivers.shp": large,
        "rivers.dbf": small,
        "notes.txt": "y\n",
      })
      const after = yield* capture()

      expect(yield* service.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("notes.txt"),
      ])
    }),
  )
})
