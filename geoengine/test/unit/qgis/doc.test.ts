import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { until } from "../../support/common.ts"
import { darwin, fakeApp, mark, READY, CATALOG, fake, start } from "../../support/qgis.ts"

test(
  "QGIS lists its algorithms once for every documentation request, and again for another QGIS",
  {
    skip: !darwin,
  },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
    try {
      const listings = path.join(directory, "listings")
      const catalog = `echo listed >> '${listings}'; sleep 0.3; ${mark(CATALOG)}`
      const app = await fakeApp(directory, { python: fake(READY, "exit 9", catalog) })
      const other = await fakeApp(directory, { name: "Other.app", python: fake(READY, "exit 9", catalog) })
      const engine = await start(app)
      const count = async () => (await fs.readFile(listings, "utf-8")).split("\n").filter(Boolean).length
      try {
        assert.equal((await engine.settled()).status, "ready")
        const [groups, help] = await Promise.all([
          engine.request({ action: "groups" }, 10000, "qgis.doc"),
          engine.request({ action: "help", algorithm: "buffer" }, 10000, "qgis.doc"),
        ])
        assert.ok(groups.ok && help.ok, JSON.stringify([groups, help]))
        assert.ok((await engine.request({ action: "search", query: "buffer" }, 10000, "qgis.doc")).ok)
        assert.equal(await count(), 1)

        // Counted from before the request: a quick check can begin and settle before the request is answered.
        const before = engine.states().length
        assert.ok((await engine.request({ path: other }, 10000, "qgis.configure")).ok)
        await until(
          () =>
            engine
              .states()
              .slice(before)
              .some((state) => state.status === "checking"),
          5000,
          "the new check",
        )
        assert.equal((await engine.settled()).status, "ready")
        assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
        // Guards against documenting another installation from the first one's list.
        assert.equal(await count(), 2)
      } finally {
        await engine.stop()
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "a request cancelled while QGIS lists its algorithms leaves the listing to the next one",
  { skip: !darwin },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
    try {
      const listings = path.join(directory, "listings")
      const gate = path.join(directory, "gate")
      const catalog = `echo listed >> '${listings}'; while [ ! -e '${gate}' ]; do sleep 0.05; done; ${mark(CATALOG)}`
      const app = await fakeApp(directory, { python: fake(READY, "exit 9", catalog) })
      const engine = await start(app)
      try {
        assert.equal((await engine.settled()).status, "ready")
        const first = engine.send({ action: "groups" }, "qgis.doc")
        await until(async () => (await fs.readFile(listings, "utf-8").catch(() => "")) !== "", 5000, "the listing")
        engine.deliver({ type: "cancel", id: first })
        const cancelled = await engine.response(first)
        assert.ok(!cancelled.ok && cancelled.cancelled, JSON.stringify(cancelled))
        const second = engine.send({ action: "groups" }, "qgis.doc")
        await fs.writeFile(gate, "")
        assert.ok((await engine.response(second)).ok)
        // Guards against the cancel stopping the listing, or leaving the next request waiting on it forever.
        assert.equal((await fs.readFile(listings, "utf-8")).split("\n").filter(Boolean).length, 1)
      } finally {
        await engine.stop()
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("a listing that fails is reported and made again on the next request", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const failedOnce = path.join(directory, "failed-once")
    const catalog = `if [ -e '${failedOnce}' ]; then ${mark(CATALOG)}; else touch '${failedOnce}'; echo 'Traceback: boom' >&2; exit 1; fi`
    const app = await fakeApp(directory, { python: fake(READY, "exit 9", catalog) })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "ready")
      const first = await engine.request({ action: "groups" }, 10000, "qgis.doc")
      assert.ok(!first.ok && first.error.code === "catalog-failed", JSON.stringify(first))
      assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
