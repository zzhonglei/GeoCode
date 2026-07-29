import { afterEach, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/* Geodata never enters the checkpoint repository (docs/GEOKERNEL.md §10.1 #6).
 *
 * One scene is hundreds of megabytes and a project holds many, so without this
 * a checkpoint costs more than the work it protects. The failure is quiet — a
 * working feature, a disk filling up over weeks — which is why it is pinned
 * here rather than left to review. */

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
      // `.dat` is a MapInfo companion AND an ordinary extension. It is in the
      // taxonomy but NOT in the snapshot's blanket list, precisely so this rule
      // cannot swallow a user's own file (§10.1 #5).
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
  "geodata already committed in the user's repo is dropped too",
  Effect.gen(function* () {
    // THE case that costs real money. The source repo's check-ignore never sees
    // the snapshot's exclude, and a gitignore rule has no effect on an
    // already-tracked file — so a committed scene, seeded into the snapshot
    // index along with everything else, would be re-hashed into the object
    // store on every checkpoint until the disk is gone.
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
