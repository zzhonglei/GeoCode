import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { serve, start } from "../../support/osm.ts"

test("a check, asked before the user is, looks at the params and the boundary file and runs nothing", async () => {
  const services = await serve({})
  // No Python is there: a check that started it would fail.
  const engine = await start(path.join(path.parse(process.cwd()).root, "geocode-test-no-python"), services.services)
  try {
    // A File Geodatabase is a folder.
    const boundary = path.join(engine.directory, "campus.gdb")
    await fs.mkdir(boundary)
    const output = path.join(engine.directory, "roads.gpkg")
    const area = `file:${boundary}|layername=campus`
    const ready = await engine.call("check", { action: "features", area, tags: ["highway"], output })
    assert.deepEqual(ready.ok && ready.result, {}, JSON.stringify(ready))
    const refused = [
      { action: "probe", area: `file:${path.join(engine.directory, "gone.gpkg")}`, tags: ["building"] },
      { action: "probe", area: "file:campus.gdb", tags: ["building"] },
      { action: "objects", ids: ["R1"], output: "roads.gpkg" },
      { action: "search" },
      { action: "delete", name: "x" },
    ]
    for (const params of refused) {
      const checked = await engine.call("check", params)
      assert.equal(!checked.ok && checked.error.code, "invalid-params", JSON.stringify(params))
    }
    assert.deepEqual(services.asked, [])
  } finally {
    await engine.stop()
    await services.close()
  }
})
