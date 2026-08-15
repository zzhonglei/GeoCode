import { afterEach, expect, test } from "bun:test"
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

test("what may be staged answers to the snapshot's own ignores, not only the source repo's", () => {
  // `stage()` reports any non-zero exit as "failed to add snapshot files", and
  // `git add` exits non-zero when handed a path its exclude file covers — while
  // still adding everything else. Drop the geodata half of this rule and a
  // geographic project collects that warning on every single checkpoint, at
  // which point the one that means something looks exactly like it.
  //
  // Asserted on the rule rather than through a checkpoint because the two
  // outcomes are indistinguishable from outside: same patch, same store, same
  // files on disk. That is what kept this expression untested while it was
  // inline, and why it is a named function now.
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

it.live(
  "a rollback leaves geodata where it found it — it cannot restore one, and must not delete one",
  Effect.gen(function* () {
    /* Geodata is outside the checkpoint mechanism by design: a scene is too
     * large to store every turn, so there is nothing to roll back TO. What that
     * costs is stated above. What it must not cost is the scene itself.
     *
     * `revert` restores a file with `git checkout <hash> -- <file>` against the
     * snapshot, and when that fails on a path the snapshot tree does not hold,
     * it DELETES the file instead — the branch upstream's suite exercises with
     * `nonexistent.txt`. Geodata is absent from that tree by construction, so
     * the only thing between a rollback and a user's raster is `patch.files` not
     * naming it, which holds because `drop()` runs before the `diff --cached`
     * that builds the list.
     *
     * Three links, and none of them was pinned against a rollback: the two cases
     * above assert `patch.files` and never revert; the upstream suite reverts
     * and has no geodata. The failure this guards is not a disk filling up over
     * weeks — it is the scene gone in one turn, with no checkpoint of it to go
     * back to, because we deliberately never made one. */
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

      // And the scene is untouched. NOT "was not restored" — restoring and
      // deleting are different branches of `revert`, and it is the deleting one
      // that takes the user's data with it.
      const survived = yield* Effect.promise(() => Bun.file(`${dir}/committed.tif`).exists())
      expect(survived).toBe(true)
      const scene = yield* Effect.promise(() => Bun.file(`${dir}/committed.tif`).text())
      expect(scene).toBe("what the agent overwrote it with")
    }).pipe(provideInstance(dir))
  }),
)
