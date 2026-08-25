import { afterEach, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/* Geodata never enters the checkpoint repository (docs/GEOKERNEL.md §10.1 #6), a rule whose failure is silent: a
 * working feature and a disk filling up over weeks. */

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")
const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const exec = (cwd: string, command: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" })
    const code = await proc.exited
    if (code !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  })
const gitTmpdir = () => tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))

afterEach(async () => {
  await disposeAllInstances()
})

test("what may be staged answers to the snapshot's own ignores, not only the source repo's", () => {
  // Drop the geodata half and `git add` still keeps the raster out, but exits non-zero over it, which `stage()`
  // reports as "failed to add snapshot files" on every checkpoint a geographic project ever takes.
  const all = ["notes.md", "build/out.js", "scene.tif"]
  const sourceIgnored = new Set(["build/out.js"]) // the user's own .gitignore
  const geoIgnored = new Set(["scene.tif"]) // the snapshot repo's info/exclude
  expect(Snapshot.stageable(all, sourceIgnored, geoIgnored)).toEqual(["notes.md"])
})

it.live(
  "new geodata is never checkpointed, and ordinary files still are",
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/readme.md`, "start")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])

    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()

      yield* write(`${dir}/scene.tif`, "raster bytes")
      yield* write(`${dir}/layer.shp`, "geometry")
      yield* write(`${dir}/layer.shx`, "index")
      yield* write(`${dir}/city.gpkg-wal`, "write ahead log")
      yield* write(`${dir}/notes.md`, "an ordinary file")
      // A MapInfo companion that geo-extensions.ts holds back from the blanket list, so it stays a user's own
      // file here (§10.1 #5).
      yield* write(`${dir}/measurements.dat`, "not a GIS file")

      const patch = yield* snapshot.patch(before!)
      expect(patch.files).toContain(fwd(dir, "notes.md"))
      expect(patch.files).toContain(fwd(dir, "measurements.dat"))
      for (const excluded of ["scene.tif", "layer.shp", "layer.shx", "city.gpkg-wal"]) {
        expect(patch.files).not.toContain(fwd(dir, excluded))
      }
    }).pipe(provideInstance(dir))
  }),
)

it.live(
  "the metadata rule is qualified by what it sits beside, and spares ordinary XML",
  Effect.gen(function* () {
    /* A bare `*.xml` — the shape this rule replaced — takes `pom.xml` and `web.xml` out of the checkpoint with
     * the metadata, and an edit to a file outside the checkpoint outlives the rollback meant to undo it. */
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/readme.md`, "start")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init"])

    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()

      // GDAL's PAM sidecar and ArcGIS metadata, companions to data this block already excludes.
      yield* write(`${dir}/scene.tif.aux.xml`, "<PAMDataset/>")
      yield* write(`${dir}/roads.shp.xml`, "<metadata/>")
      // Ordinary project files, root and nested, since a bare `*.xml` matches at any depth.
      yield* write(`${dir}/pom.xml`, "<project/>")
      yield* write(`${dir}/config/web.xml`, "<web-app/>")

      const patch = yield* snapshot.patch(before!)
      for (const excluded of ["scene.tif.aux.xml", "roads.shp.xml"]) {
        expect(patch.files).not.toContain(fwd(dir, excluded))
      }
      for (const kept of ["pom.xml", fwd("config", "web.xml")]) {
        expect(patch.files).toContain(fwd(dir, kept))
      }
    }).pipe(provideInstance(dir))
  }),
)

it.live(
  "geodata already committed in the user's repo is dropped too",
  Effect.gen(function* () {
    // An ignore rule has no effect on an already-tracked file, so without the `ls-files` sweep a committed scene
    // is re-hashed into the object store on every checkpoint.
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/readme.md`, "start")
    yield* write(`${dir}/committed.tif`, "raster bytes")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init with geodata"])

    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()

      yield* write(`${dir}/readme.md`, "edited")
      yield* write(`${dir}/committed.tif`, "different raster bytes")

      const patch = yield* snapshot.patch(before!)
      expect(patch.files).toContain(fwd(dir, "readme.md"))
      // Tracked in the user's repo, and still not in ours.
      expect(patch.files).not.toContain(fwd(dir, "committed.tif"))
    }).pipe(provideInstance(dir))
  }),
)

it.live(
  "a rollback leaves geodata where it found it — it cannot restore one, and must not delete one",
  Effect.gen(function* () {
    /* `revert` DELETES any path the snapshot tree does not hold, and geodata is absent from that tree by
     * construction, so all that stands between a rollback and a user's raster is `patch.files` not naming it. */
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/readme.md`, "start")
    yield* write(`${dir}/committed.tif`, "the original raster")
    yield* exec(dir, ["git", "add", "."])
    yield* exec(dir, ["git", "commit", "-m", "init with geodata"])

    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()

      yield* write(`${dir}/readme.md`, "edited")
      yield* write(`${dir}/committed.tif`, "what the agent overwrote it with")

      const patch = yield* snapshot.patch(before!)
      yield* snapshot.revert([patch])

      // The rollback really happened. Without this the rest passes on a no-op.
      const readme = yield* Effect.promise(() => Bun.file(`${dir}/readme.md`).text())
      expect(readme).toBe("start")

      // Untouched, which for geodata means the agent's bytes rather than the original.
      const survived = yield* Effect.promise(() => Bun.file(`${dir}/committed.tif`).exists())
      expect(survived).toBe(true)
      const scene = yield* Effect.promise(() => Bun.file(`${dir}/committed.tif`).text())
      expect(scene).toBe("what the agent overwrote it with")
    }).pipe(provideInstance(dir))
  }),
)
