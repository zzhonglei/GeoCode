import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Qgis } from "../../../src/qgis/index.ts"
import { until, alive } from "../../support/common.ts"
import { darwin, fakeApp, mark, READY, fake, start } from "../../support/qgis.ts"

test("a changed configuration checks again and ends the check it replaces", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const marker = path.join(directory, "slow-pid")
    const slow = await fakeApp(path.join(directory, "slow"), { python: `echo $$ > '${marker}'; exec sleep 60` })
    const fast = await fakeApp(path.join(directory, "fast"), { python: READY })
    const engine = await start(slow)
    try {
      await until(async () => (await fs.stat(marker).catch(() => undefined)) !== undefined, 5000, "the slow probe")
      const pid = Number(await fs.readFile(marker, "utf-8"))
      await fs.writeFile(path.join(engine.directory, "machine.json"), JSON.stringify({ qgis: { path: fast } }))
      await until(() => engine.states().at(-1)?.status === "ready", 5000, "the new check")
      // Guards against the old probe running on to its own clock after nobody wants its answer.
      await until(() => !alive(pid), 5000, "the old probe to end")
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against GeoAgent being told QGIS is not configured right after writing machine.json, as it is told a saved file
// takes effect at once: the call comes within the watch's debounce.
test("a call right after machine.json is written sees the QGIS it names", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: fake(READY, "exit 9") })
    const engine = await start(undefined)
    try {
      assert.equal((await engine.settled()).status, "unconfigured")
      await fs.writeFile(path.join(engine.directory, "machine.json"), JSON.stringify({ qgis: { path: app } }))
      const response = await engine.request({ action: "groups" }, 10000, "qgis.doc")
      assert.ok(response.ok, JSON.stringify(response))
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against GeoAgent being stuck with a QGIS reinstalled where it was, which changes nothing in machine.json, and
// against each of the calls GeoAgent sends together starting a check of its own.
test("each tool call checks a broken QGIS again, once for calls sent together", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const repaired = path.join(directory, "repaired")
    const probes = path.join(directory, "probes")
    const broken = mark({ python: "3.12.11", failed: "core", error: "No module named qgis" })
    const probe = `echo probe >> '${probes}'; sleep 0.5; if [ -e '${repaired}' ]; then ${READY}; else ${broken}; fi`
    const app = await fakeApp(directory, { python: fake(probe, "exit 9") })
    const engine = await start(app)
    const count = async () => (await fs.readFile(probes, "utf-8")).split("\n").filter(Boolean).length
    try {
      assert.equal((await engine.settled()).status, "core-missing")
      assert.equal(await count(), 1)
      const ids = [engine.send({ action: "groups" }, "qgis.doc"), engine.send({ path: "/data/x.tif" }, "qgis.read")]
      // The last arrives while that check runs, as calls a few milliseconds apart do.
      await until(async () => (await count()) === 2, 5000, "the second check")
      ids.push(engine.send({ algorithm: "native:buffer", parameters: {} }, "qgis.locate"))
      for (const id of ids) {
        const response = await engine.response(id)
        assert.ok(!response.ok && response.error.code === "not-ready", JSON.stringify(response))
        assert.equal((response.error.details as Qgis.State).status, "core-missing")
      }
      assert.equal(await count(), 2)
      await fs.writeFile(repaired, "")
      assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
      assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
      // Guards against a ready QGIS being checked on every call.
      assert.equal(await count(), 3)
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against GeoAgent being told of another file than the one GeoEngine reads.
test("a QGIS that is not ready is answered with where its configuration is", async () => {
  const engine = await start(undefined)
  try {
    const machine = path.join(engine.directory, "machine.json")
    const unconfigured = await engine.request({ action: "groups" }, 10000, "qgis.doc")
    assert.ok(!unconfigured.ok && unconfigured.error.code === "not-ready", JSON.stringify(unconfigured))
    assert.ok(unconfigured.error.message.includes(machine), unconfigured.error.message)
    await fs.writeFile(machine, "{ broken")
    await until(() => engine.states().at(-1)?.status === "config-error", 5000, "the broken file")
    const unreadable = await engine.request({ action: "groups" }, 10000, "qgis.doc")
    assert.ok(!unreadable.ok && unreadable.error.message.includes(machine), JSON.stringify(unreadable))
  } finally {
    await engine.stop()
  }
})
