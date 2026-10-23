import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { until, alive } from "../../support/common.ts"
import { darwin, fakeApp, mark, READY, CATALOG, fake, start } from "../../support/qgis.ts"

test("a run streams progress and messages, but not the outputs QGIS lists", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    // Paused between lines of the two streams, which keep no order between them; each marks the start on its own.
    const run = [
      "echo 'noise from a library'",
      "echo 'QGIS starting' >&2",
      mark({ type: "begin" }),
      "sleep 0.2",
      "echo 'reaching its pipe after the start on the other' >&2",
      `${mark({ type: "begin" })} >&2`,
      mark({ type: "progress", percent: 50 }),
      mark({ type: "message", level: "info", text: "half way" }),
      "sleep 0.2",
      "echo 'ERROR 1: what GDAL wrote' >&2",
      "sleep 0.2",
      "echo '  printed by the algorithm  '",
      "echo '' >&2",
      "printf 'one half, '",
      "sleep 0.2",
      "echo 'between the halves' >&2",
      "sleep 0.2",
      "echo 'the other half'",
      "sleep 0.2",
      mark({ type: "message", level: "info", text: "Results: {'OUTPUT': '/data/out.gpkg'}" }),
      mark({ type: "result", ok: true, outputs: { OUTPUT: "/data/out.gpkg" } }),
      "echo 'reaching its pipe after the result' >&2",
    ].join("; ")
    const app = await fakeApp(directory, { python: `case "$1" in -) ;; *) exit 9 ;; esac\n${fake(READY, run)}` })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "ready")
      const response = await engine.request({ algorithm: "native:buffer", parameters: { DISTANCE: 1 } })
      assert.ok(response.ok, JSON.stringify(response))
      const progress = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === response.id ? [message.data] : [],
      )
      // The outputs QGIS lists as it ends are left to the end of the answer. Guards against losing what the process
      // writes itself while the algorithm runs, or telling what QGIS writes as it starts.
      assert.deepEqual(progress, [
        { begun: true },
        { percent: 50 },
        { level: "info", text: "half way" },
        { level: "console", text: "ERROR 1: what GDAL wrote" },
        { level: "console", text: "  printed by the algorithm  " },
        { level: "console", text: "between the halves" },
        { level: "console", text: "one half, the other half" },
        { level: "console", text: "reaching its pipe after the result" },
      ])
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a cancelled run answers at once and ends its process, checked or not", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const marker = path.join(directory, "run-pid")
    const run = `echo $$ > '${marker}'; ${mark({ type: "progress", percent: 1 })}; exec sleep 60`
    const slow = await fakeApp(path.join(directory, "slow"), { python: fake("exec sleep 60", run) })
    const engine = await start(slow)
    try {
      // Guards against a cancel waiting out the check before it is noticed.
      const waiting = engine.send({ algorithm: "native:buffer", parameters: {} })
      engine.deliver({ type: "cancel", id: waiting })
      const early = await engine.response(waiting, 2000)
      assert.ok(!early.ok && early.cancelled && early.error.code === "cancelled", JSON.stringify(early))
    } finally {
      await engine.stop()
    }

    const ready = await fakeApp(path.join(directory, "ready"), { python: fake(READY, run) })
    const second = await start(ready)
    try {
      assert.equal((await second.settled()).status, "ready")
      const id = second.send({ algorithm: "native:buffer", parameters: {} })
      await until(
        () => second.sent.some((message) => message.type === "progress" && message.id === id),
        5000,
        "progress",
      )
      const pid = Number(await fs.readFile(marker, "utf-8"))
      second.deliver({ type: "cancel", id })
      const response = await second.response(id)
      assert.ok(!response.ok && response.cancelled && response.error.code === "cancelled", JSON.stringify(response))
      await until(() => !alive(pid), 5000, "the run to end")
    } finally {
      await second.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against two runs checked side by side writing to one name, and a name held on after its run.
test("a checked run holds the new names of its outputs until it ends", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const inspect = mark({ layers: [["point"]], tables: [] })
    const run = mark({ type: "result", ok: true, outputs: {} })
    const app = await fakeApp(directory, { python: fake(READY, run, mark(CATALOG), inspect) })
    const engine = await start(app)
    const at = (name: string) => path.join(directory, name)
    await fs.writeFile(at("out.gpkg"), "")
    try {
      assert.equal((await engine.settled()).status, "ready")
      const prepare = async () => {
        const response = await engine.request(
          {
            algorithm: "native:buffer",
            parameters: { INPUT: "in.geojson", OUTPUT: "out.gpkg" },
            files: [at("in.geojson"), at("out.gpkg")],
          },
          10000,
          "qgis.prepare",
        )
        assert.ok(response.ok, JSON.stringify(response))
        return (response.result as { plan: { parameters: { OUTPUT: string } } }).plan.parameters
      }
      const first = await prepare()
      assert.equal(first.OUTPUT, at("out_1.gpkg"))
      assert.equal((await prepare()).OUTPUT, at("out_2.gpkg"))
      assert.ok((await engine.request({ algorithm: "native:buffer", parameters: first })).ok)
      // Its run over, the name is free again; this fake run wrote nothing there.
      assert.equal((await prepare()).OUTPUT, at("out_1.gpkg"))
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
