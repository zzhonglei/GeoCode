import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { until } from "../../support/common.ts"
import { python3, raise, lower, start, result } from "../../support/gee.ts"

/** Writes the user's assets the stubbed earthengine-api lists, in the project "majestic", with no exports yet. */
const holding = (directory: string, assets: readonly object[]) =>
  fs.writeFile(path.join(directory, "stubs", "flags", "assets.json"), JSON.stringify({ assets, operations: [] }))

const ROOT = "projects/majestic/assets/GeoCode"
const folder = (name: string, updateTime: string) => ({ type: "FOLDER", name, id: name, updateTime })

test("a run reads its task in GeoCode's folder, for the answer to start with", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      { type: "IMAGE", name: `${task}/composite`, updateTime: "2026-10-08T06:00:00Z" },
      { type: "TABLE", name: `${task}/area`, updateTime: "2026-10-08T02:00:00Z" },
    ])
    const done = result(
      await engine.response(
        engine.send({
          script: "print(1)",
          cwd: engine.directory,
          task: { name: "taipei-ndvi-20261008", new: false, started: false },
        }),
      ),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "1\n")
    const space = (done as unknown as { space: { assets: { name: string }[] } }).space
    assert.deepEqual(
      space.assets.map((asset) => asset.name),
      ["composite", "area"],
    )

    // A task to continue that saved nothing and that this conversation did not start: a mistyped name, likely.
    const marker = path.join(engine.directory, "ran")
    const typo = await engine.response(
      engine.send({
        script: `open(${JSON.stringify(marker)}, "w").write("ran")`,
        cwd: engine.directory,
        task: { name: "taipei-ndvi-20261080", new: false, started: false },
      }),
    )
    assert.equal(!typo.ok && typo.error.code, "task-missing")
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )

    // Guards against a run that only reads leaving anything in the user's Earth Engine.
    await holding(engine.directory, [])
    assert.equal(
      result(await engine.response(engine.send({ script: "print(2)", cwd: engine.directory }))).outcome,
      "finished",
    )
    const left = JSON.parse(await fs.readFile(path.join(engine.directory, "stubs", "flags", "assets.json"), "utf-8"))
    assert.deepEqual(left.assets, [])
  } finally {
    await engine.stop()
  }
})

test("the header stays within the line GeoEngine reads", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    // A hundred assets with descriptions far longer than anyone writes.
    const root = `${ROOT}/taipei-ndvi-20261008`
    const long = (index: number) => ({
      type: "IMAGE",
      name: `${root}/asset_${index}`,
      updateTime: `2026-10-08T00:00:${String(index % 60).padStart(2, "0")}Z`,
      properties: { title: "标".repeat(100), description: "说".repeat(1000) },
    })
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(root, "2026-10-08T00:00:00Z"),
      ...Array.from({ length: 100 }, (_, index) => long(index)),
    ])
    const continuing = { name: "taipei-ndvi-20261008", new: false, started: false }
    const full = result(
      await engine.response(engine.send({ script: "print(1)", cwd: engine.directory, task: continuing })),
    )
    // Guards against a header longer than GeoEngine reads a line, which would lose the whole of it.
    const space = (full as unknown as { space: { assets: unknown[]; more: number } }).space
    assert.ok(space.more > 0, `${space.assets.length} listed, ${space.more} more`)
    assert.equal(space.assets.length + space.more, 100)
  } finally {
    await engine.stop()
  }
})

test("a new task whose name is taken is refused before the script runs", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const task = `${ROOT}/taipei-ndvi-20261008`
    await holding(engine.directory, [
      folder(ROOT, "2026-09-01T00:00:00Z"),
      folder(task, "2026-10-08T01:00:00Z"),
      { type: "IMAGE", name: `${task}/composite`, updateTime: "2026-10-08T06:00:00Z" },
      { type: "TABLE", name: `${task}/area`, updateTime: "2026-10-08T02:00:00Z" },
    ])
    const marker = path.join(engine.directory, "ran")
    const script = `open(${JSON.stringify(marker)}, "w").write("ran")`
    const taken = await engine.response(
      engine.send({ script, cwd: engine.directory, task: { name: "taipei-ndvi-20261008", new: true, started: false } }),
    )
    assert.equal(!taken.ok && taken.error.code, "task-taken")
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
    )
  } finally {
    await engine.stop()
  }
})

// Guards against two runs of one task, from parallel calls or two conversations, racing to save the same assets.
test("a task runs one call at a time, while other tasks run beside it", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const release = path.join(engine.directory, "release")
    const held = `import os, time\nwhile not os.path.exists(${JSON.stringify(release)}):\n    time.sleep(0.05)\nprint("done")`
    const task = (name: string) => ({ name, new: false, started: true })
    const first = engine.send({ script: held, cwd: engine.directory, task: task("a-20261009") })
    await until(() => engine.progress(first).length > 0, 10000, "the first run to begin")

    const busy = await engine.response(
      engine.send({ script: "print(1)", cwd: engine.directory, task: task("a-20261009") }),
    )
    assert.equal(!busy.ok && busy.error.code, "task-busy")
    const beside = result(
      await engine.response(engine.send({ script: "print(2)", cwd: engine.directory, task: task("b-20261009") })),
    )
    assert.equal(beside.output, "2\n")

    await fs.writeFile(release, "")
    assert.equal(result(await engine.response(first)).output, "done\n")
    const again = result(
      await engine.response(engine.send({ script: "print(3)", cwd: engine.directory, task: task("a-20261009") })),
    )
    assert.equal(again.output, "3\n")
  } finally {
    await engine.stop()
  }
})

type Stored = {
  assets: { name: string; type: string; properties?: Record<string, string> }[]
  operations: { metadata: { description: string; state: string } }[]
}
const stored = async (directory: string) =>
  JSON.parse(await fs.readFile(path.join(directory, "stubs", "flags", "assets.json"), "utf-8")) as Stored

/** The asset each export was for, in order, by the "task:asset:fingerprint" its description names. */
const exported = (held: Stored) => held.operations.map((operation) => operation.metadata.description.split(":")[1])

/**
 * A script saving to the task, with the stub's graphs standing for computations; GeoCode's wait does not sleep, and an
 * image is saved as it is, the stub having no grids.
 */
const saving = (...lines: string[]) =>
  [
    "import geocodekit.gee as gee",
    "import geocodekit.gee._outputs",
    "geocodekit.gee._outputs.POLL_SECONDS = 0",
    "geocodekit.gee._outputs.measured = lambda image, grid: (image, grid)",
    ...lines,
  ].join("\n")

const TASK = { name: "t-20261008", new: true, started: false }

test(
  "gee.save makes the task's folders, and reuses or replaces an asset by its content",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      assert.equal((await engine.settled()).status, "ready")
      await holding(engine.directory, [])
      const save = (graph: string, scale: string) =>
        `saved = gee.save(ee.Image("${graph}"), "ndvi", title="台北 NDVI", description="夏季中值", scale=${scale})`
      const script = saving(
        save("ndvi", "10"),
        "print(type(saved).__name__, saved.graph)",
        // The same grid written another way is the same content.
        save("ndvi", "10.0"),
        save("ndvi masked", "10"),
        'gee.save(ee.FeatureCollection("area"), "area", title="范围", description="研究区")',
      )
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      // What gee.save returns is the saved asset, read back.
      assert.match(done.output, new RegExp(`^Image ${ROOT}/t-20261008/ndvi$`, "m"))
      const after = await stored(engine.directory)
      assert.deepEqual(
        after.assets.map((asset) => [asset.name, asset.type]),
        [
          [ROOT, "FOLDER"],
          [`${ROOT}/t-20261008`, "FOLDER"],
          [`${ROOT}/t-20261008/ndvi`, "IMAGE"],
          [`${ROOT}/t-20261008/area`, "TABLE"],
        ],
      )
      // Exported once, not again for the same grid written another way, again for other content.
      assert.deepEqual(exported(after), ["ndvi", "ndvi", "area"])
    } finally {
      await engine.stop()
    }
  },
)

// Guards against a save built on another of the task's assets being read as unchanged after that asset was replaced:
// the computation names it by the same path.
test(
  "a save that reads one of GeoCode's assets is done again once that asset is replaced",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      assert.equal((await engine.settled()).status, "ready")
      await holding(engine.directory, [])
      const save = (data: string, name: string) => `gee.save(${data}, "${name}", title="t", description="d", scale=10)`
      const script = saving(
        `composite = ${save('ee.Image("composite")', "composite")}`,
        save("composite", "copy"),
        save("composite", "copy"),
        save('ee.Image("composite, cloudless")', "composite"),
        save('gee.load("composite")', "copy"),
      )
      result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      // The copy is reused while the composite it reads is unchanged, and exported again once that is replaced.
      assert.deepEqual(exported(await stored(engine.directory)), ["composite", "copy", "composite", "copy"])
    } finally {
      await engine.stop()
    }
  },
)

test("a failed save leaves no folder it made, and reports the failure", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    const script = saving('gee.save(ee.Image("ndvi"), "ndvi", title="t", description="d", scale=10)')
    for (const flag of ["export-fails", "export-refused"] as const) {
      await raise(engine.directory, flag)
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory, task: TASK })))
      await lower(engine.directory, flag)
      assert.equal(done.outcome, "failed")
      // GeoCode's own lines, quoted from the package's files.
      assert.match(done.output, /File "[^"]*geocodekit\/gee\/_assets\.py", line \d+, in save\n {4}\S/)
      assert.deepEqual((await stored(engine.directory)).assets, [])
    }
  } finally {
    await engine.stop()
  }
})

test("an export under way is waited for, joined, or replaced", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    await holding(engine.directory, [])
    await raise(engine.directory, "export-slow")
    const save = (graph: string) => `gee.save(ee.Image("${graph}"), "ndvi", title="t", description="d", scale=10)`
    const id = engine.send({ script: saving(save("ndvi")), cwd: engine.directory, task: TASK })
    assert.equal(result(await engine.response(id)).outcome, "finished")
    await lower(engine.directory, "export-slow")

    // A run stopped while it waits leaves its export running on the server.
    const continuing = { name: "t-20261008", new: false, started: false }
    const stopped = async (graph: string) => {
      await raise(engine.directory, "export-running")
      const id = engine.send({ script: saving(save(graph)), cwd: engine.directory, task: continuing })
      // Waiting on the export, not on the save's first status, which comes before the export is submitted.
      const exporting = () =>
        engine.progress(id).some((data) => (data as { status?: { progress?: number } }).status?.progress !== undefined)
      await until(exporting, 10000, "the export")
      engine.deliver({ type: "cancel", id })
      const response = await engine.response(id)
      assert.equal(!response.ok && response.error.code, "cancelled")
      await lower(engine.directory, "export-running")
    }
    await stopped("ndvi masked")
    // The export left running finishes on the next look at it.
    const file = path.join(engine.directory, "stubs", "flags", "assets.json")
    const left = JSON.parse(await fs.readFile(file, "utf-8"))
    left.operations.find((operation: Stored["operations"][number]) => operation.metadata.state === "RUNNING").finishes =
      true
    await fs.writeFile(file, JSON.stringify(left))
    result(
      await engine.response(
        engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
      ),
    )

    await stopped("ndvi clipped")
    // Guards against reading the saved asset while another version of it is still being exported over it.
    result(
      await engine.response(
        engine.send({ script: saving(save("ndvi masked")), cwd: engine.directory, task: continuing }),
      ),
    )
    // Joined rather than exported again, then the other version cancelled: three exports in all.
    assert.deepEqual(
      (await stored(engine.directory)).operations.map((operation) => operation.metadata.state),
      ["SUCCEEDED", "SUCCEEDED", "CANCELLED"],
    )
  } finally {
    await engine.stop()
  }
})
