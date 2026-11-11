import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { Preview } from "../../../src/preview/index.ts"
import { alive, until } from "../../support/common.ts"
import { pythonReady, start } from "../../support/engine.ts"
import { EMPTY, FATAL, FATAL_ONCE, SILENT, STAND_IN } from "../../support/preview.ts"

const NODE = process.execPath

const standIn: Preview.Launch = () => ({ command: NODE, args: ["-e", STAND_IN] })

const engine = (name: string) =>
  start(name, () => [pythonReady("/the/base/python", "1.0.0"), Preview.capability(standIn)])

type Described = { opened: { path: string; layer?: string }; pid: number; cancels: number[] }

/** The engine's answer to a request, a success's result or a failure's code. */
const answered = async (running: Awaited<ReturnType<typeof engine>>, method: string, params: object) => {
  const response = await running.response(running.send(`preview.${method}`, params))
  return response.ok ? { result: response.result } : { code: response.error.code }
}

const started = (running: Awaited<ReturnType<typeof engine>>) =>
  running.sent.flatMap((message) => (message.type === "task" && message.event === "start" ? [message.pid] : []))

test("each request is answered with its own tile, by one reader for each layer of each dataset", async () => {
  const running = await engine("preview-answers")
  try {
    const a = path.join(running.directory, "a.tif")
    const b = path.join(running.directory, "b.gpkg")
    const tiles = [
      { path: a, stamp: "s1", z: 9, x: 1, y: 2 },
      { path: b, layer: "roads", stamp: "s2", z: 9, x: 3, y: 4 },
      { path: a, stamp: "s1", z: 9, x: 5, y: 6 },
      { path: b, layer: "roads", stamp: "s2", z: EMPTY, x: 0, y: 0 },
    ]
    const ids = tiles.map((tile) => running.send("preview.tile", tile))
    const results = await Promise.all(ids.map((id) => running.response(id)))
    assert.deepEqual(
      results.map((response) => {
        assert.ok(response.ok)
        const result = response.result as { bytes?: Uint8Array; empty?: boolean }
        return result.bytes ? Buffer.from(result.bytes).toString() : result
      }),
      ["s1:9/1/2", "s2:9/3/4", "s1:9/5/6", { empty: true }],
    )
    const first = (await answered(running, "describe", { path: a })).result as Described
    const layer = (await answered(running, "describe", { path: b, layer: "roads" })).result as Described
    const other = (await answered(running, "describe", { path: b, layer: "rivers" })).result as Described
    assert.deepEqual(first.opened, { path: a })
    assert.deepEqual(layer.opened, { path: b, layer: "roads" })
    assert.equal(new Set([first.pid, layer.pid, other.pid]).size, 3)
    assert.deepEqual(started(running).toSorted(), [first.pid, layer.pid, other.pid].toSorted())
    // Guards a reader's own refusal, as of data that has changed, against reaching the interface as a plain failure.
    assert.deepEqual(await answered(running, "identify", { path: a, stamp: "s1", x: 0, y: 0, tolerance: 1 }), {
      code: "changed",
    })
  } finally {
    await running.stop()
  }
  for (const pid of started(running)) assert.equal(alive(pid), false)
})

test("a cancelled request is answered at once, and its reader is told to stop reading for it", async () => {
  const running = await engine("preview-cancel")
  try {
    const file = path.join(running.directory, "a.tif")
    const id = running.send("preview.tile", { path: file, stamp: "s", z: SILENT, x: 0, y: 0 })
    await until(() => started(running).length === 1, 5000, "the reader")
    running.deliver({ type: "cancel", id })
    const response = await running.response(id, 2000)
    assert.equal(response.cancelled, true)
    const described = (await answered(running, "describe", { path: file })).result as Described
    assert.equal(described.cancels.length, 1)
  } finally {
    await running.stop()
  }
})

test("one reader more than may run at once ends the reader asked the longest ago", async () => {
  const running = await engine("preview-limit")
  try {
    const describe = async (name: string) =>
      (await answered(running, "describe", { path: path.join(running.directory, name) })).result as Described
    const pids: Record<string, number> = {}
    for (const name of ["a", "b", "c", "d"]) pids[name] = (await describe(name)).pid
    assert.equal((await describe("a")).pid, pids.a)
    await describe("e")
    await until(() => !alive(pids.b), 5000, "the reader asked the longest ago to end")
    assert.deepEqual(
      ["a", "c", "d"].map((name) => alive(pids[name])),
      [true, true, true],
    )
    assert.notEqual((await describe("b")).pid, pids.b)
  } finally {
    await running.stop()
  }
})

// Guards a request on its way to a reader that ends just then, as one left unused does at any moment.
test("a request whose reader ends before answering is asked once more of a new reader", async () => {
  const running = await engine("preview-again")
  try {
    const file = path.join(running.directory, "a.tif")
    const once = await running.response(
      running.send("preview.tile", { path: file, stamp: "s", z: FATAL_ONCE, x: 1, y: 1 }),
    )
    assert.ok(once.ok)
    assert.equal(Buffer.from((once.result as { bytes: Uint8Array }).bytes).toString(), `s:${FATAL_ONCE}/1/1`)
    assert.equal(started(running).length, 2)
    assert.deepEqual(await answered(running, "tile", { path: file, stamp: "s", z: FATAL, x: 0, y: 0 }), {
      code: "reader-ended",
    })
    // The request no reader survives ended the reader that had answered and the one started to ask again.
    assert.equal(started(running).length, 3)
  } finally {
    await running.stop()
  }
})

// Guards a tab the app opens again as it starts: its request comes before the environment is installed or checked,
// and nothing would ask again once it is.
test("a request made while the Python environment is being prepared is answered once it is ready", async () => {
  let ready = () => {}
  const preparing = await start("preview-preparing", () => [
    pythonReady("/the/base/python", "1.0.0", new Promise((resolve) => (ready = resolve))),
    Preview.capability(standIn),
  ])
  try {
    const id = preparing.send("preview.describe", { path: "/a.tif" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(started(preparing), [])
    assert.equal(
      preparing.sent.some((message) => message.type === "response"),
      false,
    )
    ready()
    assert.ok((await preparing.response(id)).ok)
  } finally {
    await preparing.stop()
  }
})
