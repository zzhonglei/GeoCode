import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import type { Protocol } from "../src/protocol.ts"
import { Macos } from "../src/qgis/macos.ts"
import { Python } from "../src/qgis/python.ts"
import { Qgis } from "../src/qgis/index.ts"
import { Runtime } from "../src/runtime.ts"
import { Status } from "../src/status.ts"
import type { Transport } from "../src/transport.ts"

const darwin = process.platform === "darwin"

const plist = (identifier: string, version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
  `\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n` +
  `\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`

/** An app bundle shaped like QGIS's; `python` is the body of a shell script standing in for its interpreter. */
const fakeApp = async (
  directory: string,
  options: { name?: string; identifier?: string; version?: string; python?: string } = {},
) => {
  const app = path.join(directory, options.name ?? "QGIS.app")
  await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true })
  await fs.mkdir(path.join(app, "Contents", "Resources", "qgis"), { recursive: true })
  await fs.writeFile(
    path.join(app, "Contents", "Info.plist"),
    plist(options.identifier ?? "org.qgis.qgis3", options.version ?? "3.44.15"),
  )
  if (options.python !== undefined) {
    const file = path.join(app, "Contents", "MacOS", "python")
    await fs.writeFile(file, `#!/bin/sh\n${options.python}\n`)
    await fs.chmod(file, 0o755)
  }
  return app
}

const mark = (payload: unknown) => `echo '${Python.MARKER}${JSON.stringify(payload)}'`

const READY = mark({ python: "3.12.11", gdal: "3.13.3", qgis: "3.44.15-Solothurn", algorithms: 440 })

/** A fake interpreter: `probe` answers the probe script, `run` the run script (its request is in "$3"). */
const fake = (probe: string, run: string) => `case "$2" in *processing.run*) ${run} ;; *) ${probe} ;; esac`

type Response = Extract<Protocol.Outbound, { type: "response" }>

const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const start = async (configured: string | undefined) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  const machine = path.join(directory, "machine.json")
  if (configured !== undefined) await fs.writeFile(machine, JSON.stringify({ qgis: { path: configured } }))
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(machine))
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [Qgis.capability])).pipe(Effect.provide(layer)))
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "qgis" ? [message.value as Qgis.State] : [],
    )
  const settled = async (ms = 10000) => {
    await until(() => (states().at(-1)?.status ?? "checking") !== "checking", ms, "QGIS to settle")
    return states().at(-1)!
  }
  const response = async (id: number, ms = 10000) => {
    const find = () => sent.find((message): message is Response => message.type === "response" && message.id === id)
    await until(() => find() !== undefined, ms, `the response to ${id}`)
    return find()!
  }
  let nextId = 0
  const send = (params: unknown) => {
    nextId += 1
    deliver({ type: "request", id: nextId, method: "qgis.run", params })
    return nextId
  }
  const request = (params: unknown, ms = 10000) => response(send(params), ms)
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    await until(() => sent.some((message) => message.type === "ready"), 10000, "the engine")
  } catch (error) {
    await stop()
    throw error
  }
  return {
    directory,
    sent,
    states,
    settled,
    send,
    response,
    request,
    deliver: (message: unknown) => deliver(message),
    stop,
  }
}

test("a path is resolved to the QGIS app bundle it points at or into", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: "exit 0" })
    for (const configured of [app, path.join(app, "Contents", "MacOS", "python")]) {
      const located = await Macos.locate(configured)
      assert.equal(located.ok && located.install.app, app)
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("each kind of wrong path settles on its own state", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const other = await fakeApp(directory, { name: "Other.app", identifier: "com.example.other", python: "exit 0" })
    const old = await fakeApp(directory, { name: "Old.app", version: "3.28.0" })
    const cases: [string, string][] = [
      ["QGIS.app", "path-missing"],
      [path.join(directory, "Missing.app"), "path-missing"],
      [directory, "not-qgis"],
      [other, "not-qgis"],
      [old, "unsupported"],
    ]
    for (const [configured, expected] of cases) {
      const located = await Macos.locate(configured)
      assert.equal(located.ok ? "ok" : located.status, expected, configured)
    }
    const located = await Macos.locate(old)
    assert.equal(!located.ok && located.version, "3.28.0")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("no configuration settles on unconfigured, with a hint", async () => {
  const engine = await start(undefined)
  try {
    const state = await engine.settled()
    assert.equal(state.status, "unconfigured")
    assert.ok("hint" in state && state.hint.length > 0)
  } finally {
    await engine.stop()
  }
})

test("each probe report settles on its own state", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const cases: [string, string][] = [
      [READY, "ready"],
      [mark({ python: "3.12", failed: "gdal", error: "No module named osgeo" }), "gdal-missing"],
      [mark({ python: "3.12", gdal: "3.13", failed: "proj", error: "Cannot find proj.db" }), "proj-broken"],
      [mark({ python: "3.12", gdal: "3.13", failed: "core", error: "No module named qgis" }), "core-missing"],
      [
        mark({ python: "3.12", gdal: "3.13", qgis: "3.44", algorithms: 0, failed: "processing", error: "x" }),
        "processing-failed",
      ],
      // Guards against a crash before the report reading as anything but a failed probe, and losing its output.
      ["echo 'Fatal Python error: init_fs_encoding' >&2; exit 1", "probe-failed"],
      // Guards against a report missing what a ready QGIS must have reading as ready.
      [mark({ python: "3.12", gdal: "3.13" }), "probe-failed"],
    ]
    for (const [index, [python, expected]] of cases.entries()) {
      const app = await fakeApp(path.join(directory, String(index)), { python })
      const engine = await start(app)
      try {
        const state = await engine.settled()
        assert.equal(state.status, expected, python)
        if (expected === "probe-failed" && python.includes("Fatal")) {
          assert.ok("diagnostics" in state)
          assert.match(state.diagnostics.output ?? "", /init_fs_encoding/)
          assert.equal(state.diagnostics.path, app)
          assert.equal(state.diagnostics.interpreter, path.join(app, "Contents", "MacOS", "python"))
        }
      } finally {
        await engine.stop()
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

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

test("quitting during a check publishes no failure", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: "exec sleep 60" })
    const engine = await start(app)
    try {
      await until(() => engine.sent.some((message) => message.type === "task"), 5000, "the probe")
      engine.deliver({ type: "shutdown" })
      await until(() => engine.sent.some((message) => message.type === "shutdown-complete"), 10000, "the sweep")
      // Guards against a probe stopped at shutdown reading as a broken QGIS.
      assert.deepEqual(
        engine.states().map((state) => state.status),
        ["checking"],
      )
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a run streams progress and messages, and returns the outputs", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const run = [
      "echo 'noise from a library'",
      mark({ type: "progress", percent: 50 }),
      mark({ type: "message", level: "info", text: "half way" }),
      mark({ type: "result", ok: true, outputs: { OUTPUT: "/data/out.gpkg" } }),
    ].join("; ")
    const app = await fakeApp(directory, { python: `case "$1" in -c) ;; *) exit 9 ;; esac\n${fake(READY, run)}` })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "ready")
      const response = await engine.request({ algorithm: "native:buffer", parameters: { DISTANCE: 1 } })
      assert.ok(response.ok, JSON.stringify(response))
      assert.deepEqual(response.ok && response.result, {
        outputs: { OUTPUT: "/data/out.gpkg" },
        messages: [{ level: "info", text: "half way" }],
      })
      const progress = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === response.id ? [message.data] : [],
      )
      assert.deepEqual(progress, [{ percent: 50 }, { level: "info", text: "half way" }])
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a run sent while QGIS is being checked waits for the check", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const result = mark({ type: "result", ok: true, outputs: {} })
    const app = await fakeApp(directory, { python: fake(`sleep 1; ${READY}`, result) })
    const engine = await start(app)
    try {
      assert.equal(engine.states().at(-1)?.status, "checking")
      const response = await engine.request({ algorithm: "native:buffer", parameters: {} })
      assert.ok(response.ok, JSON.stringify(response))
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

test("a run that fails says how", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const missing = mark({ type: "result", ok: false, stage: "run", error: "Algorithm not found" })
    const run = `case "$3" in *native:missing*) ${missing} ;; *) echo 'Segmentation fault' >&2; exit 139 ;; esac`
    const app = await fakeApp(directory, { python: fake(READY, run) })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "ready")
      const failed = await engine.request({ algorithm: "native:missing", parameters: {} })
      assert.equal(!failed.ok && failed.error.code, "algorithm-failed")
      assert.equal(!failed.ok && failed.error.message, "Algorithm not found")
      const crashed = await engine.request({ algorithm: "native:buffer", parameters: {} })
      assert.equal(!crashed.ok && crashed.error.code, "crashed")
      assert.match(JSON.stringify(!crashed.ok && crashed.error.details), /Segmentation fault/)
      for (const params of [
        { algorithm: 42 },
        { algorithm: "native:buffer", parameters: {}, idleTimeoutSeconds: Number.POSITIVE_INFINITY },
        { algorithm: "native:buffer", parameters: {}, cwd: path.join(directory, "no such folder") },
      ]) {
        const invalid = await engine.request(params)
        assert.equal(!invalid.ok && invalid.error.code, "invalid-params", JSON.stringify(params))
      }
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a run before QGIS is ready is refused with the state and its hint", async () => {
  const engine = await start(path.join(os.tmpdir(), "geoengine-no-such-qgis", "QGIS.app"))
  try {
    await engine.settled()
    const response = await engine.request({ algorithm: "native:buffer", parameters: {} })
    assert.ok(!response.ok)
    assert.equal(response.error.code, "not-ready")
    assert.equal((response.error.details as Qgis.State).status, darwin ? "path-missing" : "platform-unsupported")
  } finally {
    await engine.stop()
  }
})

/** Real installations: GEOENGINE_QGIS_APPS (colon-separated), or every supported /Applications/QGIS*.app. */
const realApps = async () => {
  if (!darwin) return []
  if (process.env.GEOENGINE_QGIS_APPS) return process.env.GEOENGINE_QGIS_APPS.split(":").filter(Boolean)
  const names = await fs.readdir("/Applications").catch(() => [] as string[])
  const apps = names.filter((name) => /^QGIS.*\.app$/.test(name)).map((name) => path.join("/Applications", name))
  const located = await Promise.all(apps.map(async (app) => ((await Macos.locate(app)).ok ? [app] : [])))
  return located.flat()
}

for (const app of await realApps()) {
  test(`QGIS at ${app} gets ready and runs a built-in algorithm on Chinese paths and values`, async () => {
    const engine = await start(app)
    const data = path.join(engine.directory, "数据 目录")
    try {
      const state = await engine.settled(150000)
      assert.equal(state.status, "ready", JSON.stringify(state))
      assert.ok(state.status === "ready" && state.algorithms > 100)

      await fs.mkdir(data)
      const input = path.join(data, "点.geojson")
      const output = path.join(data, "缓冲区.gpkg")
      await fs.writeFile(
        input,
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { 名称: "台北" },
              geometry: { type: "Point", coordinates: [121.56, 25.03] },
            },
          ],
        }),
      )
      const response = await engine.request(
        { algorithm: "native:buffer", parameters: { INPUT: input, DISTANCE: 0.01, OUTPUT: output } },
        120000,
      )
      assert.ok(response.ok, JSON.stringify(response))
      const result = response.result as { outputs: { OUTPUT: string }; messages: unknown[] }
      assert.equal(result.outputs.OUTPUT, output)
      // Guards against QGIS renaming the feedback methods the run script overrides, which would drop every message.
      assert.ok(result.messages.length > 0)
      // Guards against attribute text reaching QGIS through a codec other than UTF-8.
      const value = execFileSync("sqlite3", [output, 'SELECT "名称" FROM "缓冲区"'], { encoding: "utf-8" })
      assert.equal(value.trim(), "台北")
    } finally {
      await engine.stop()
    }
  })

  test(`QGIS at ${app} stops a cancelled run and its process`, async () => {
    const engine = await start(app)
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      const id = engine.send({
        algorithm: "native:randompointsinextent",
        parameters: {
          EXTENT: "0,100,0,100 [EPSG:3857]",
          POINTS_NUMBER: 50000000,
          MIN_DISTANCE: 0,
          OUTPUT: path.join(engine.directory, "points.gpkg"),
        },
      })
      await until(
        () => engine.sent.some((message) => message.type === "progress" && message.id === id),
        60000,
        "progress",
      )
      const task = engine.sent.findLast((message) => message.type === "task" && message.event === "start")
      engine.deliver({ type: "cancel", id })
      const response = await engine.response(id)
      assert.ok(!response.ok && response.cancelled && response.error.code === "cancelled", JSON.stringify(response))
      assert.ok(task?.type === "task")
      await until(() => !alive(task.pid), 5000, "QGIS to end")
    } finally {
      await engine.stop()
    }
  })
}
