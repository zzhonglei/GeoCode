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

const parameter = (name: string, type: string, fields: Record<string, unknown> = {}) => ({
  name,
  description: name,
  type,
  optional: false,
  advanced: false,
  destination: false,
  help: "",
  default: null,
  accepted: [],
  ...fields,
})

const CATALOG = {
  ok: true,
  qgis: "3.44.15-Solothurn",
  algorithms: [
    {
      id: "native:buffer",
      name: "Buffer",
      group: "Vector geometry",
      description: "Computes a buffer area.",
      help: "",
      tags: [],
      notes: 0,
      parameters: [
        parameter("INPUT", "source"),
        parameter("DISTANCE", "distance", { default: 10 }),
        parameter("OUTPUT", "sink", { destination: true }),
      ],
      outputs: [],
    },
  ],
  excluded: [{ id: "native:openurl", name: "Open file or URL" }],
  vectorExtensions: ["gpkg", "shp", "geojson"],
}

// Without the quotes QGIS writes around its examples, which the fake's shell would take as its own.
const REPROJECT = {
  id: "native:reprojectlayer",
  name: "Reproject layer",
  group: "Vector general",
  description: "Reprojects a layer.",
  help: "",
  tags: [],
  notes: 0,
  parameters: [
    parameter("INPUT", "source"),
    parameter("TARGET_CRS", "crs", {
      default: "EPSG:4326",
      accepted: ["CRS as an auth ID (e.g. EPSG:3111)", "CRS as a PROJ4 string (e.g. PROJ4:…)"],
    }),
    parameter("OUTPUT", "sink", { destination: true }),
  ],
  outputs: [],
}

/**
 * A fake interpreter: `probe` answers the probe script, `run` the run script, `inspect` the survey of the data and
 * `crs` the check of coordinate reference systems (their requests are in "$3"), `catalog` the listing of the
 * algorithms.
 */
const fake = (probe: string, run: string, catalog = mark(CATALOG), inspect = "exit 9", crs = "exit 9") =>
  `case "$2" in *parameterAsCrs*) ${crs} ;; *processing.run*) ${run} ;; *parameterTypes*) ${catalog} ;; ` +
  `*GT_IsSurface*) ${inspect} ;; *) ${probe} ;; esac`

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
  const send = (params: unknown, method = "qgis.run") => {
    nextId += 1
    deliver({ type: "request", id: nextId, method, params })
    return nextId
  }
  const request = (params: unknown, ms = 10000, method = "qgis.run") => response(send(params, method), ms)
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
      [old, "python-missing"],
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

test("no configuration settles on unconfigured", async () => {
  const engine = await start(undefined)
  try {
    const state = await engine.settled()
    assert.equal(state.status, "unconfigured")
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

test("a run streams progress and messages, and ends its answer with the outputs", { skip: !darwin }, async () => {
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
    const app = await fakeApp(directory, { python: `case "$1" in -c) ;; *) exit 9 ;; esac\n${fake(READY, run)}` })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "ready")
      const response = await engine.request({ algorithm: "native:buffer", parameters: { DISTANCE: 1 } })
      assert.ok(response.ok, JSON.stringify(response))
      assert.match(
        (response.result as { ending: string }).ending,
        /^Finished in [\d.]+ s\.\nOutputs:\n- OUTPUT: \/data\/out\.gpkg$/,
      )
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

test("a run that fails says how, and which outputs it may have left half written", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    // On one line: the fake's echo would break a line at an escaped newline.
    const error = "Incorrect parameter value for DISTANCE"
    const refused = [
      mark({ type: "message", level: "error", text: error }),
      mark({ type: "result", ok: false, stage: "run", error }),
    ].join("; ")
    const run = `case "$3" in *bad*) ${refused} ;; *) echo 'Segmentation fault' >&2; exit 139 ;; esac`
    const app = await fakeApp(directory, { python: fake(READY, run) })
    const engine = await start(app)
    const half = path.join(directory, "half.gpkg")
    await fs.writeFile(half, "")
    try {
      assert.equal((await engine.settled()).status, "ready")
      const failed = await engine.request({
        algorithm: "native:buffer",
        parameters: { DISTANCE: "bad", OUTPUT: half },
      })
      assert.ok(!failed.ok && failed.error.code === "algorithm-failed", JSON.stringify(failed))
      assert.equal(failed.error.message, error)
      assert.match(
        (failed.error.details as { ending: string }).ending,
        new RegExp(
          `^Failed after [\\d.]+ s\\.\\nDISTANCE: DISTANCE \\(distance, default 10\\)\\n` +
            `These outputs may be incomplete:\\n- ${half.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        ),
      )
      const crashed = await engine.request({ algorithm: "native:buffer", parameters: {} })
      assert.ok(!crashed.ok && crashed.error.code === "crashed", JSON.stringify(crashed))
      assert.match(JSON.stringify(crashed.error.details), /Segmentation fault/)
      assert.match((crashed.error.details as { ending: string }).ending, /^QGIS exited unexpectedly after [\d.]+ s\.$/)
      // Guards against running what the checks before asking would refuse, should a caller skip them.
      const unchecked = await engine.request({ algorithm: "native:openurl", parameters: {} })
      assert.ok(!unchecked.ok && unchecked.error.code === "invalid-params", JSON.stringify(unchecked))
      assert.match(unchecked.error.message, /native:openurl is not available\.$/)
      for (const params of [
        { algorithm: 42 },
        { algorithm: "native:buffer" },
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

test(
  "a run is checked before it is asked about: refused, or planned with its outputs named anew",
  { skip: !darwin },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
    try {
      const surveyed = path.join(directory, "surveyed")
      const inspect =
        `echo "$3" >> '${surveyed}'; case "$3" in *mixed*) ${mark({ layers: [["line", "point"]], tables: [] })} ;; ` +
        `*) ${mark({ layers: [["point"]], tables: [] })} ;; esac`
      const asked = path.join(directory, "asked")
      const crs =
        `echo "$(pwd) $3" >> '${asked}'; case "$3" in *tmerc*) ${mark({ ok: true, read: [false] })} ;; ` +
        `*broken*) exit 9 ;; *) ${mark({ ok: true, read: [true] })} ;; esac`
      const run = mark({ type: "result", ok: true, outputs: {} })
      const catalog = mark({ ...CATALOG, algorithms: [...CATALOG.algorithms, REPROJECT] })
      const app = await fakeApp(directory, { python: fake(READY, run, catalog, inspect, crs) })
      const engine = await start(app)
      const at = (name: string) => path.join(directory, name)
      await fs.writeFile(at("out.gpkg"), "")
      try {
        assert.equal((await engine.settled()).status, "ready")
        const locate = async (parameters: unknown) => {
          const response = await engine.request({ algorithm: "native:buffer", parameters }, 10000, "qgis.locate")
          assert.ok(response.ok, JSON.stringify(response))
          return response.result
        }
        const prepare = async (parameters: unknown, files: string[]) => {
          const response = await engine.request(
            { algorithm: "native:buffer", parameters, files },
            10000,
            "qgis.prepare",
          )
          assert.ok(response.ok, JSON.stringify(response))
          return response.result as { refused?: string; plan?: { parameters: { OUTPUT: string }; header: string } }
        }

        assert.deepEqual(await locate({ INPUT: "in.geojson", OUTPUT: "out.gpkg" }), {
          files: ["in.geojson", "out.gpkg"],
        })
        const wrong = (await locate({ INPUT: "in.geojson", distance: 5 })) as { refused: string }
        assert.match(wrong.refused, /^QGIS 3\.44\.15-Solothurn\nnative:buffer — Buffer: Computes a buffer area\.\n\n/)
        assert.match(wrong.refused, /\ndistance is written DISTANCE\.\n/)

        for (const files of [["in.geojson", at("out.gpkg")], [at("in.geojson")]]) {
          const response = await engine.request(
            { algorithm: "native:buffer", parameters: { INPUT: "in.geojson", OUTPUT: "out.gpkg" }, files },
            10000,
            "qgis.prepare",
          )
          assert.ok(!response.ok && response.error.code === "invalid-params", JSON.stringify(response))
        }

        const mixed = await prepare({ INPUT: "mixed.geojson", OUTPUT: "x.gpkg" }, [at("mixed.geojson"), at("x.gpkg")])
        assert.match(mixed.refused ?? "", /\n\nmixed\.geojson mixes points and lines in one layer, so nothing was run/)

        const parameters = { INPUT: "in.geojson", OUTPUT: "out.gpkg" }
        const files = [at("in.geojson"), at("out.gpkg")]
        const first = await prepare(parameters, files)
        assert.equal(first.plan?.parameters.OUTPUT, at("out_1.gpkg"))
        // Guards against two runs checked side by side writing to one name.
        assert.equal((await prepare(parameters, files)).plan?.parameters.OUTPUT, at("out_2.gpkg"))
        assert.ok((await engine.request({ algorithm: "native:buffer", parameters: first.plan?.parameters })).ok)
        // Its run over, the name is free again; this fake run wrote nothing there.
        assert.equal((await prepare(parameters, files)).plan?.parameters.OUTPUT, at("out_1.gpkg"))

        // A layer whose geometry type is chosen after the path, and a run with no input, are not surveyed.
        const before = (await fs.readFile(surveyed, "utf-8")).split("\n").filter(Boolean).length
        await prepare({ INPUT: "in.geojson|geometrytype=Point", OUTPUT: "y.gpkg" }, [at("in.geojson"), at("y.gpkg")])
        await prepare({ OUTPUT: "z.gpkg" }, [at("z.gpkg")])
        assert.equal((await fs.readFile(surveyed, "utf-8")).split("\n").filter(Boolean).length, before)

        // A CRS QGIS does not read is refused with what QGIS says it accepts; QGIS is asked from where the run runs.
        const reproject = async (target: string | undefined) => {
          const parameters = {
            INPUT: "in.gpkg|layername=a",
            OUTPUT: "r.gpkg",
            ...(target ? { TARGET_CRS: target } : {}),
          }
          const response = await engine.request(
            { algorithm: "native:reprojectlayer", parameters, files: [at("in.gpkg"), at("r.gpkg")], cwd: directory },
            10000,
            "qgis.prepare",
          )
          assert.ok(response.ok, JSON.stringify(response))
          return response.result as { refused?: string; plan?: unknown }
        }
        assert.equal(
          (await reproject("+proj=tmerc +lon_0=121")).refused?.split("\n\n")[1],
          'TARGET_CRS is "+proj=tmerc +lon_0=121", which QGIS does not read as a coordinate reference system, so ' +
            "nothing was run: QGIS would run as if it were not given.\nQGIS accepts:\n" +
            "- CRS as an auth ID (e.g. EPSG:3111)\n- CRS as a PROJ4 string (e.g. PROJ4:…)",
        )
        assert.ok((await reproject("EPSG:3826")).plan)
        // A check that cannot answer lets the run go on, for the run to say what is wrong.
        assert.ok((await reproject("broken")).plan)
        // A CRS left to its default is not asked about.
        assert.ok((await reproject(undefined)).plan)
        const lines = (await fs.readFile(asked, "utf-8")).split("\n").filter(Boolean)
        assert.equal(lines.length, 3)
        assert.equal(lines[0], `${await fs.realpath(directory)} {"values":["+proj=tmerc +lon_0=121"]}`)
      } finally {
        await engine.stop()
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("a run before QGIS is ready is refused with the state", async () => {
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

// Guards against GeoEngine's own words about a failed check being shown as what QGIS printed.
test("a check that fails without output says so in its own words", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: "exit 1" })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "probe-failed")
      const response = await engine.request({ action: "groups" }, 10000, "qgis.doc")
      assert.ok(!response.ok, JSON.stringify(response))
      const [first, second] = response.error.message.split("\n")
      assert.equal(first, `The configured QGIS, ${app} (3.44.15), does not work: it failed while being checked.`)
      assert.equal(second, "The check failed: QGIS's Python exited with code 1 without a valid report")
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against a version deciding what GeoAgent is told: it hears what went wrong, as with any other QGIS.
test("a QGIS whose Python cannot be found is reported as what went wrong", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { version: "3.28.0" })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "python-missing")
      const response = await engine.request({ action: "groups" }, 10000, "qgis.doc")
      assert.ok(!response.ok && response.error.code === "not-ready", JSON.stringify(response))
      const [first, second] = response.error.message.split("\n")
      assert.equal(
        first,
        `The configured QGIS, ${app} (3.28.0), does not work: it has no Contents/MacOS/python to start its Python with.`,
      )
      assert.ok(second?.startsWith("Ask the user to reinstall QGIS"), second)
      // A QGIS installed where it was is seen by the next call.
      await fakeApp(directory, { version: "3.44.15", python: fake(READY, "exit 9") })
      assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against listing by name, which misses a renamed QGIS, against offering an app that is not QGIS, against
// leaving out a QGIS whose Python cannot be found, which the check, not the list, has to report, and against listing a
// symlinked QGIS twice.
test("the QGIS installs are found by identity, newest first", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const folder = path.join(directory, "Applications")
    const renamed = await fakeApp(folder, { name: "QGIS 4.2.app", version: "4.2.3", python: "exit 0" })
    const ltr = await fakeApp(folder, { name: "QGIS-LTR.app", version: "3.44.15", python: "exit 0" })
    const old = await fakeApp(folder, { name: "QGIS 3.28.app", version: "3.28.0" })
    await fakeApp(folder, { name: "Other.app", identifier: "com.example.other", python: "exit 0" })
    const elsewhere = await fakeApp(path.join(directory, "Tools"), {
      name: "Geo.app",
      version: "3.44.2",
      python: "exit 0",
    })
    const linked = path.join(folder, "Geo.app")
    await fs.symlink(elsewhere, linked)
    const trashed = await fakeApp(path.join(directory, ".Trash"), { version: "4.0.0", python: "exit 0" })
    const spotlight = [path.join(renamed, "Contents", "MacOS", "python"), elsewhere, trashed]
    const found = await Macos.installs(spotlight, [folder, path.join(directory, "missing")])
    assert.deepEqual(found, [
      { app: renamed, version: "4.2.3" },
      { app: ltr, version: "3.44.15" },
      { app: linked, version: "3.44.2" },
      { app: old, version: "3.28.0" },
    ])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against a choice made in the settings that never reaches machine.json, or reaches it without a check.
test("choosing a QGIS writes it to machine.json and checks it", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: READY })
    const engine = await start(undefined)
    try {
      assert.equal((await engine.settled()).status, "unconfigured")
      engine.deliver({ type: "request", id: 100, method: "qgis.configure", params: { path: "QGIS.app" } })
      assert.equal(((await engine.response(100)) as { error?: { code: string } }).error?.code, "invalid-params")
      engine.deliver({ type: "request", id: 101, method: "qgis.configure", params: { path: app } })
      assert.ok((await engine.response(101)).ok)
      await until(() => engine.states().at(-1)?.status === "ready", 5000, "the check of the chosen QGIS")
      const written = JSON.parse(await fs.readFile(path.join(engine.directory, "machine.json"), "utf-8"))
      assert.deepEqual(written, { qgis: { path: app } })
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against a choice overwriting a machine.json the user broke by hand, or its refusal naming where the file is.
test("a choice is refused while machine.json cannot be read", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const app = await fakeApp(directory, { python: READY })
    const engine = await start(undefined)
    try {
      const machine = path.join(engine.directory, "machine.json")
      await fs.writeFile(machine, '{ "qgis": ')
      await until(() => engine.states().at(-1)?.status === "config-error", 5000, "the broken file to be read")
      engine.deliver({ type: "request", id: 100, method: "qgis.configure", params: { path: app } })
      const response = (await engine.response(100)) as { error?: { code: string; message: string } }
      assert.equal(response.error?.code, "config-unreadable")
      assert.ok(!response.error?.message.includes(engine.directory))
      assert.equal(await fs.readFile(machine, "utf-8"), '{ "qgis": ')
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

// Guards against a QGIS repaired in place staying failed until the app restarts.
test("a recheck probes the configured QGIS again", { skip: !darwin }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-qgis-"))
  try {
    const repaired = path.join(directory, "repaired")
    const broken = mark({ python: "3.12.11", failed: "core", error: "No module named 'qgis'" })
    const app = await fakeApp(directory, { python: `if [ -e '${repaired}' ]; then ${READY}; else ${broken}; fi` })
    const engine = await start(app)
    try {
      assert.equal((await engine.settled()).status, "core-missing")
      await fs.writeFile(repaired, "")
      engine.deliver({ type: "request", id: 100, method: "qgis.recheck" })
      assert.ok((await engine.response(100)).ok)
      await until(() => engine.states().at(-1)?.status === "ready", 5000, "the recheck")
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
        const message = response.error.message
        assert.ok(
          message.startsWith(
            `The configured QGIS, ${app} (3.44.15), does not work: its Python cannot load QGIS itself.`,
          ),
        )
        assert.ok(
          message.includes(
            `The check ran ${path.join(app, "Contents", "MacOS", "python")} and printed:\nNo module named qgis\n`,
          ),
        )
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
        const text = (response: Response) => (response.ok ? (response.result as { text: string }).text : "")
        assert.equal(text(groups), "QGIS 3.44.15-Solothurn\n\n1 groups, 1 algorithms:\nVector geometry (1)")
        assert.ok(text(help).includes("Buffer (native:buffer)"))
        assert.ok((await engine.request({ action: "search", query: "buffer" }, 10000, "qgis.doc")).ok)
        assert.equal(await count(), 1)

        assert.ok((await engine.request({ path: other }, 10000, "qgis.configure")).ok)
        await until(() => engine.states().at(-1)?.status === "checking", 5000, "the new check")
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
      assert.deepEqual(first.error.details, { stderr: "Traceback: boom\n" })
      assert.ok((await engine.request({ action: "groups" }, 10000, "qgis.doc")).ok)
    } finally {
      await engine.stop()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("documentation of a QGIS that is not ready answers with the state and what to do", async () => {
  const engine = await start(undefined)
  try {
    const response = await engine.request({ action: "groups" }, 10000, "qgis.doc")
    assert.ok(!response.ok && response.error.code === "not-ready", JSON.stringify(response))
    const machine = path.join(engine.directory, "machine.json")
    // Guards against GeoAgent being left to guess where the file is and how to find QGIS, as it once wrote elsewhere.
    assert.ok(response.error.message.startsWith(`QGIS is not configured.\nIts configuration is in ${machine}, as`))
    assert.ok(response.error.message.includes(Macos.FINDING))
    const invalid = await engine.request({ action: "read" }, 10000, "qgis.doc")
    assert.ok(!invalid.ok && invalid.error.code === "invalid-params")
    await fs.writeFile(machine, "{ broken")
    await until(() => engine.states().at(-1)?.status === "config-error", 5000, "the broken file")
    const unreadable = await engine.request({ action: "groups" }, 10000, "qgis.doc")
    assert.ok(!unreadable.ok && unreadable.error.message.startsWith(`${machine} cannot be read: `))
  } finally {
    await engine.stop()
  }
})

/** Real installations: GEOENGINE_QGIS_APPS (colon-separated), or every /Applications/QGIS*.app whose Python is found. */
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
      assert.ok((response.result as { ending: string }).ending.endsWith(`\n- OUTPUT: ${output}`))
      // Guards against attribute text reaching QGIS through a codec other than UTF-8.
      const value = execFileSync("sqlite3", [output, 'SELECT "名称" FROM "缓冲区"'], { encoding: "utf-8" })
      assert.equal(value.trim(), "台北")
    } finally {
      await engine.stop()
    }
  })

  test(`QGIS at ${app} checks a run as the kernel does, and measures on the WGS 84 ellipsoid`, async () => {
    const engine = await start(app)
    const at = (name: string) => path.join(engine.directory, name)
    const square = (south: number) => ({
      type: "Feature",
      properties: { south },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, south],
            [1, south],
            [1, south + 1],
            [0, south + 1],
            [0, south],
          ],
        ],
      },
    })
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      await fs.writeFile(
        at("cells.geojson"),
        JSON.stringify({ type: "FeatureCollection", features: [square(0), square(60)] }),
      )
      await fs.writeFile(
        at("mixed.geojson"),
        JSON.stringify({
          type: "FeatureCollection",
          features: [square(0), { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }],
        }),
      )
      await fs.writeFile(at("area.gpkg"), "")
      const step = async (method: string, params: unknown) => {
        const response = await engine.request(params, 120000, method)
        assert.ok(response.ok, JSON.stringify(response))
        return response.result as Record<string, any>
      }
      const request = {
        algorithm: "native:fieldcalculator",
        parameters: { INPUT: "cells.geojson", FIELD_NAME: "a", FIELD_TYPE: 0, FORMULA: "$area", OUTPUT: "area.gpkg" },
      }
      const located = await step("qgis.locate", request)
      assert.deepEqual(located.files, ["cells.geojson", "area.gpkg"])
      const prepared = await step("qgis.prepare", { ...request, files: [at("cells.geojson"), at("area.gpkg")] })
      const plan = prepared.plan
      assert.ok(plan, JSON.stringify(prepared))
      assert.equal(plan.parameters.OUTPUT, at("area_1.gpkg"))
      assert.match(plan.header, /\nDefaults used: FIELD_LENGTH=0, FIELD_PRECISION=0$/)
      assert.ok(plan.algorithm.translations["zh-CN"].name && plan.algorithm.translations["zh-TW"].name)
      assert.notEqual(plan.algorithm.translations["zh-CN"].name, plan.algorithm.name)
      const ran = await step("qgis.run", { algorithm: request.algorithm, parameters: plan.parameters })
      assert.match(ran.ending, /^Finished in /)
      const areas = execFileSync("sqlite3", [at("area_1.gpkg"), 'SELECT "a" FROM "area_1" ORDER BY "south"'], {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .map(Number)
      // A planar measure gives the two cells one area; on the ellipsoid the one at 60° N is about half.
      assert.ok(Math.abs(areas[0]! / 1.2308e10 - 1) < 0.01, String(areas))
      assert.ok(Math.abs(areas[1]! / areas[0]! - 0.493) < 0.02, String(areas))

      // Guards against QGIS renaming the feedback methods the run script overrides, which would drop every message.
      const buffered = await engine.request(
        {
          algorithm: "gdal:buffervectors",
          parameters: { INPUT: at("cells.geojson"), DISTANCE: 0.1, OUTPUT: at("b.gpkg") },
        },
        120000,
      )
      assert.ok(buffered.ok, JSON.stringify(buffered))
      const messages = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === buffered.id && "level" in (message.data as object)
          ? [message.data as { level: string; text: string }]
          : [],
      )
      assert.ok(
        messages.some((message) => message.level === "command" && message.text.includes("ogr2ogr")),
        JSON.stringify(messages),
      )

      // An algorithm that changes its input answers with the layer; the answer names its file, not the object.
      await fs.copyFile(at("cells.geojson"), at("scratch.geojson"))
      const truncated = await step("qgis.run", {
        algorithm: "native:truncatetable",
        parameters: { INPUT: at("scratch.geojson") },
      })
      assert.match(
        truncated.ending,
        new RegExp(`\\n- OUTPUT: ${at("scratch.geojson").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      )

      const mixed = await step("qgis.prepare", {
        algorithm: "native:buffer",
        parameters: { INPUT: "mixed.geojson", DISTANCE: 1, OUTPUT: "m.gpkg" },
        files: [at("mixed.geojson"), at("m.gpkg")],
      })
      assert.match(mixed.refused, /\n\nmixed\.geojson mixes points and polygons in one layer/)
      assert.deepEqual(
        await fs.readdir(engine.directory).then((names) => names.filter((name) => name.startsWith("mixed"))),
        ["mixed.geojson"],
      )

      // A PROJ string without its prefix QGIS does not read, and would reproject nothing: refused with QGIS's own
      // forms. With the prefix it reads it, and a layer's path from where the run runs.
      const reproject = (target: string) =>
        step("qgis.prepare", {
          algorithm: "native:reprojectlayer",
          parameters: { INPUT: "cells.geojson", TARGET_CRS: target, OUTPUT: "p.gpkg" },
          files: [at("cells.geojson"), at("p.gpkg")],
          cwd: engine.directory,
        })
      const tmerc = "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs"
      assert.match(
        (await reproject(tmerc)).refused,
        /\n\nTARGET_CRS is "\+proj=tmerc [^"]+", which QGIS does not read as a coordinate reference system, so nothing was run: QGIS would run as if it were not given\.\nQGIS accepts:\n- CRS as an auth ID /,
      )
      assert.ok((await reproject(`PROJ:${tmerc}`)).plan)
      assert.ok((await reproject("cells.geojson")).plan)

      // Guards against losing what PROJ and GDAL write themselves while the algorithm runs, and against telling
      // Qt's own diagnostics as QGIS starts.
      const unread = await engine.request(
        {
          algorithm: "native:reprojectlayer",
          parameters: { INPUT: at("cells.geojson"), TARGET_CRS: "EPSG:999999", OUTPUT: at("q.gpkg") },
        },
        120000,
      )
      assert.ok(unread.ok, JSON.stringify(unread))
      const written = engine.sent.flatMap((message) =>
        message.type === "progress" && message.id === unread.id && "level" in (message.data as object)
          ? [message.data as { level: string; text: string }]
          : [],
      )
      assert.ok(
        written.some((message) => message.level === "console" && message.text.includes("EPSG:999999")),
        JSON.stringify(written),
      )
      assert.ok(!written.some((message) => message.text.startsWith("qt.")), JSON.stringify(written))
      assert.match(
        (await step("qgis.locate", { algorithm: "native:openurl", parameters: {} })).refused,
        /\n\nnative:openurl is not available\.$/,
      )
    } finally {
      await engine.stop()
    }
  })

  test(`QGIS at ${app} documents the algorithms GeoCode offers from its own definitions`, async () => {
    const engine = await start(app)
    try {
      const state = await engine.settled(150000)
      assert.ok(state.status === "ready", JSON.stringify(state))
      const doc = async (params: unknown) => {
        const response = await engine.request(params, 120000, "qgis.doc")
        assert.ok(response.ok, JSON.stringify(response))
        return (response.result as { text: string }).text
      }
      const buffer = await doc({ action: "help", algorithm: "native:buffer" })
      assert.ok(buffer.startsWith(`QGIS ${state.versions.qgis}\n\nBuffer (native:buffer)`))
      assert.ok(buffer.includes("\tArgument type:\tdistance in the units of INPUT's CRS"))
      assert.ok(buffer.includes("\t\t- Path to a vector layer"))
      assert.ok(!buffer.includes("field:FIELD_NAME"))
      // Guards against linking another release's manual.
      const release = /^\d+\.\d+/.exec(state.versions.qgis)?.[0]
      assert.ok(buffer.includes(`webfetch(url="https://docs.qgis.org/${release}/en/`), buffer.slice(-300))
      const join = await doc({ action: "help", algorithm: "native:joinattributesbylocation" })
      assert.ok(join.includes("\tArgument type:\tfield of JOIN, multiple values allowed"))
      assert.ok(join.includes("\tArgument type:\tenum, multiple values allowed"))
      // Guards against numbering the options of an enum that refuses numbers.
      const dxf = await doc({ action: "help", algorithm: "native:dxfexport" })
      assert.ok(dxf.includes("\tAvailable values:\n\t\t- ISO-8859-1\n") && !dxf.includes("- 0: ISO-8859-1"))
      // Guards against offering an algorithm that needs QGIS's interface.
      assert.match(
        await doc({ action: "help", algorithm: "native:selectbyexpression" }),
        /^\w+:selectbyexpression is not available\.$/,
      )
      // Guards against the interface counting algorithms GeoAgent cannot use.
      assert.ok((await doc({ action: "groups" })).includes(` groups, ${state.algorithms} algorithms:\n`))
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

  test(`QGIS at ${app} reads geographic data as GDAL finds it, and leaves nothing beside it`, async () => {
    const engine = await start(app)
    const data = path.join(engine.directory, "数据 目录")
    try {
      assert.equal((await engine.settled(150000)).status, "ready")
      await fs.mkdir(data)
      await makeData(app, data)
      const before = await snapshot(data)
      const read = async (params: Record<string, unknown>) => {
        const response = await engine.request(
          { ...params, path: path.join(data, params.path as string) },
          120000,
          "qgis.read",
        )
        assert.ok(response.ok, JSON.stringify(response))
        return response.result as { text: string; image?: string }
      }

      const gbk = (await read({ path: "县.shp" })).text
      // Guards against reading a shapefile that declares no encoding as bytes, which garbles Chinese text.
      assert.ok(gbk.includes("\nEncoding: GB18030, detected; the file declares none."), gbk)
      assert.ok(gbk.includes('\n1. {"name":"鄂城区"}\n'), gbk)
      assert.ok(gbk.includes("\nLayer: 县, MultiPolygon, 20 features\n"), gbk)
      const miscoded = (await read({ path: "乡.shp" })).text
      // Guards against taking a .cpg at its word when the text proves it wrong.
      assert.ok(miscoded.includes("\nEncoding: GB18030, detected; the .cpg file says UTF-8, but the text"), miscoded)
      assert.ok(miscoded.includes('\n1. {"name":"鄂城区"}\n'), miscoded)
      const names = (await read({ path: "统计.shp" })).text
      // Guards against detecting the encoding from the values alone, which leaves Chinese field names garbled.
      assert.ok(names.includes('\n- 生产总值 (String): one value: "12"\n'), names)
      // Guards against GDAL failing the read when asked to move past the last feature.
      const past = (await read({ path: "县.shp", offset: 21 })).text
      assert.ok(past.endsWith("\nOffset 21 is past the last of the 20 features."), past)
      assert.equal(
        (await read({ path: "县.shp", encoding: "NOPE" })).text,
        'GDAL does not know the encoding "NOPE". Use a name such as GBK, Big5, CP1251, Shift_JIS or ISO-8859-1.',
      )

      const mixed = (await read({ path: "mixed.geojson" })).text
      assert.ok(
        mixed.includes("\nLayer: mixed, mixed geometry, 4 features: 2 points, 1 line, 1 without geometry\n"),
        mixed,
      )
      assert.ok(mixed.includes('\nLines (1 feature):\n- name (String): one value: "长江大桥"\n'), mixed)
      // Guards against GDAL's spelling of a number it had to keep as text, which reading in order brings out.
      const ratings = (await read({ path: "ratings.geojson" })).text
      assert.ok(ratings.includes('\n- rating (JSON): "4.8" ×2, "5" ×1\n'), ratings)
      assert.ok(ratings.includes('\n1. {"rating":"4.8"}\n'), ratings)
      const codes = (await read({ path: "codes.geojson" })).text
      // Guards against respelling text that only looks like a number, and against JavaScript rounding a 64-bit id.
      assert.ok(codes.includes('\n- code (JSON): "007" ×2, "5" ×1\n'), codes)
      assert.ok(codes.includes('\n- id (Integer64): one value: "612345678901234567"\n'), codes)

      // Guards against the extent of zeros GDAL gives a GeoJSON layer whose features have no geometry.
      const unplaced = (await read({ path: "unplaced.geojson" })).text
      assert.ok(
        unplaced.includes("\nLayer: unplaced, no geometry, 1 feature\n") && !unplaced.includes("Extent"),
        unplaced,
      )

      const unused = (await read({ path: "metres.geojson", encoding: "GBK" })).text
      assert.ok(unused.includes("\nencoding was not used: it applies only to Shapefiles.\n"), unused)

      const metres = (await read({ path: "metres.geojson" })).text
      assert.ok(metres.includes("\nCRS: unknown. GeoJSON coordinates are longitudes and latitudes"), metres)
      assert.ok((await read({ path: "roads.gml" })).text.includes("\nLayer: roads, LineString, 1 feature\n"))

      const layers = (await read({ path: "multi.gpkg" })).text
      assert.equal(
        layers,
        [
          "multi.gpkg: GeoPackage, 3 layers",
          "- points: vector, Point, 1 feature, EPSG:4326 (WGS 84)",
          "- population: table without geometry, 1 row",
          "- dem: raster, 4 × 3 pixels, 1 band, EPSG:4326 (WGS 84)",
          'Read one with layer="<name>".',
        ].join("\n"),
      )
      const table = (await read({ path: "multi.gpkg", layer: "population" })).text
      assert.ok(table.includes("\n- pop (Integer64): one value: 668000\n"), table)
      const dem = (await read({ path: "multi.gpkg", layer: "dem" })).text
      assert.ok(dem.startsWith("multi.gpkg, layer dem: raster, GeoPackage\nSize: 4 × 3 pixels, 1 band"), dem)
      // Guards against reading a raster table of a GeoPackage open elsewhere without the changes in its -wal.
      const held = (await read({ path: "open.gpkg", layer: "dem" })).text
      assert.ok(held.includes("\nExtent: 115, 30.97 to 115.04, 31 (xmin, ymin to xmax, ymax)\n"), held)

      const landcover = (await read({ path: "landcover.tif" })).text
      // Guards against taking the approximate statistics cached in the .aux.xml for the raster's own.
      assert.ok(
        landcover.includes(
          "\n1. landcover (Byte), no data 0, 91.7% valid: 3 values: 1 ×5 (45.5%), 2 ×4 (36.4%), 9 ×2 (18.2%)",
        ),
        landcover,
      )
      const blank = await read({ path: "blank.tif", preview: true })
      assert.deepEqual(blank, { text: "Band 1 has no valid pixels, so there is no picture." })
      const preview = await read({ path: "landcover.tif", preview: true })
      assert.ok(preview.image?.startsWith("iVBORw0KGgo"), "a PNG")
      assert.ok(
        preview.text.includes(
          "\nBand 1 (landcover), one colour per value: 1 rgb(0, 100, 0), 2 rgb(250, 230, 160), 9 rgb(0, 0, 0).",
        ),
        preview.text,
      )
      assert.equal(
        (await read({ path: "photo.png" })).text,
        "photo.png has no georeferencing: no transform, control points, RPC coefficients, geolocation arrays or CRS. It is an image, not geographic data.",
      )

      // Guards against a read writing beside the data: a .aux.xml, a .gfs, or a changed GeoPackage. SQLite indexes the
      // -wal of the one open elsewhere in its -shm, as that program does.
      const after = await snapshot(data)
      delete after["open.gpkg-shm"]
      assert.deepEqual(after, before)
    } finally {
      await engine.stop()
    }
  })
}

test("reading before QGIS is ready answers with the state, and a relative path is refused", async () => {
  const engine = await start(undefined)
  try {
    const response = await engine.request({ path: "/data/x.tif" }, 10000, "qgis.read")
    assert.ok(!response.ok && response.error.code === "not-ready", JSON.stringify(response))
    const relative = await engine.request({ path: "x.tif" }, 10000, "qgis.read")
    assert.ok(!relative.ok && relative.error.code === "invalid-params", JSON.stringify(relative))
    const limit = await engine.request({ path: "/data/x.tif", limit: 51 }, 10000, "qgis.read")
    assert.ok(!limit.ok && limit.error.code === "invalid-params", JSON.stringify(limit))
  } finally {
    await engine.stop()
  }
})

/** Every file under a directory with its content, to compare before and after. */
async function snapshot(directory: string) {
  const files = await fs.readdir(directory, { recursive: true })
  const entries = await Promise.all(
    files.sort().map(async (name) => [name, (await fs.readFile(path.join(directory, name))).toString("base64")]),
  )
  return Object.fromEntries(entries)
}

/** Writes the test data with QGIS's own GDAL: what each reader case needs, in the shapes real files take. */
async function makeData(app: string, directory: string) {
  const located = await Macos.locate(app)
  assert.ok(located.ok)
  const point = (name: string, coordinates: unknown, properties: object) => ({
    type: "Feature",
    properties,
    geometry: name === "none" ? null : { type: name, coordinates },
  })
  await fs.writeFile(
    path.join(directory, "mixed.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        point("Point", [114.3, 30.59], { name: "黄鹤楼", rating: 4.8 }),
        point("MultiPoint", [[114.28, 30.58]], { name: "出口", rating: "5" }),
        point(
          "LineString",
          [
            [114.25, 30.55],
            [114.35, 30.62],
          ],
          { name: "长江大桥" },
        ),
        point("none", [], { name: "无几何" }),
      ],
    }),
  )
  await fs.writeFile(
    path.join(directory, "ratings.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [4.8, "5", 4.8].map((rating) => point("Point", [114.3, 30.5], { rating })),
    }),
  )
  // Written as text: JSON.stringify cannot spell an integer past 2^53.
  const coded = (code: string) =>
    `{"type":"Feature","properties":{"id":612345678901234567,"code":${code}},"geometry":{"type":"Point","coordinates":[114.3,30.5]}}`
  await fs.writeFile(
    path.join(directory, "codes.geojson"),
    `{"type":"FeatureCollection","features":[${['"007"', '"007"', "5"].map(coded).join(",")}]}`,
  )
  await fs.writeFile(
    path.join(directory, "unplaced.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: [point("none", [], { name: "无几何" })] }),
  )
  await fs.writeFile(
    path.join(directory, "metres.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: [point("Point", [-621020, 3946706], { name: "四川" })] }),
  )
  const script = String.raw`
import os, shutil, sqlite3, sys
from osgeo import gdal, ogr, osr
gdal.UseExceptions()
os.chdir(sys.argv[1])
wgs84 = osr.SpatialReference()
wgs84.ImportFromEPSG(4326)

# In GBK, the one without a .cpg, the other with a .cpg that says UTF-8.
for county in ("县", "乡"):
    shapefile = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(county + ".shp")
    layer = shapefile.CreateLayer(county, wgs84, ogr.wkbPolygon, options=["ENCODING=CP936"])
    layer.CreateField(ogr.FieldDefn("name", ogr.OFTString))
    # Enough text to tell GBK from Big5, as a real table of names has.
    for name in "鄂城区 龙里县 华容区 梁子湖区 光明区 高陵区 洪山区 江夏区 黄陂区 新洲区 蔡甸区 汉南区 武昌区 青山区 硚口区 汉阳区 江岸区 江汉区 东西湖区 黄石港区".split():
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetField("name", name)
        feature.SetGeometry(ogr.CreateGeometryFromWkt("POLYGON ((114.6 30.2, 115 30.2, 115 30.4, 114.6 30.2))"))
        layer.CreateFeature(feature)
    shapefile = None
os.remove("县.cpg")
with open("乡.cpg", "w") as cpg:
    cpg.write("UTF-8")

# Chinese only in the field names.
shapefile = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource("统计.shp")
layer = shapefile.CreateLayer("统计", wgs84, ogr.wkbPoint, options=["ENCODING=CP936"])
for name in ("人口", "面积", "生产总值"):
    layer.CreateField(ogr.FieldDefn(name, ogr.OFTString))
feature = ogr.Feature(layer.GetLayerDefn())
for name in ("人口", "面积", "生产总值"):
    feature.SetField(name, "12")
feature.SetGeometry(ogr.CreateGeometryFromWkt("POINT (114.3 30.59)"))
layer.CreateFeature(feature)
shapefile = None
os.remove("统计.cpg")

package = ogr.GetDriverByName("GPKG").CreateDataSource("multi.gpkg")
points = package.CreateLayer("points", wgs84, ogr.wkbPoint)
feature = ogr.Feature(points.GetLayerDefn())
feature.SetGeometry(ogr.CreateGeometryFromWkt("POINT (114.3 30.59)"))
points.CreateFeature(feature)
table = package.CreateLayer("population", None, ogr.wkbNone)
table.CreateField(ogr.FieldDefn("pop", ogr.OFTInteger64))
feature = ogr.Feature(table.GetLayerDefn())
feature.SetField("pop", 668000)
table.CreateFeature(feature)
styles = package.CreateLayer("layer_styles", None, ogr.wkbNone)
styles.CreateField(ogr.FieldDefn("styleQML", ogr.OFTString))
package = None
memory = gdal.GetDriverByName("MEM").Create("", 4, 3, 1, gdal.GDT_Int16)
memory.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
memory.SetSpatialRef(wgs84)
memory.GetRasterBand(1).WriteArray(__import__("numpy").arange(12, dtype="int16").reshape(3, 4))
gdal.Translate("multi.gpkg", memory, format="GPKG", creationOptions=["APPEND_SUBDATASET=YES", "RASTER_TABLE=dem"])
# As a GeoPackage QGIS has edited is left; reading one would put a -wal and a -shm beside it.
connection = sqlite3.connect("multi.gpkg")
connection.execute("PRAGMA journal_mode=WAL")
connection.close()
# As one another program holds open is left: its last change, a raster moved a degree east, only in the -wal. Two
# rasters, so each opens as a subdataset.
shutil.copy("multi.gpkg", "held.gpkg")
gdal.Translate("held.gpkg", memory, format="GPKG", creationOptions=["APPEND_SUBDATASET=YES", "RASTER_TABLE=slope"])
connection = sqlite3.connect("held.gpkg")
connection.execute("PRAGMA wal_autocheckpoint=0")
for table in ("gpkg_tile_matrix_set", "gpkg_contents"):
    connection.execute(f"UPDATE {table} SET min_x = min_x + 1, max_x = max_x + 1 WHERE table_name = 'dem'")
connection.commit()
shutil.copy("held.gpkg", "open.gpkg")
shutil.copy("held.gpkg-wal", "open.gpkg-wal")
connection.close()
for name in ("held.gpkg", "held.gpkg-wal", "held.gpkg-shm"):
    if os.path.exists(name):
        os.remove(name)

tif = gdal.GetDriverByName("GTiff").Create("landcover.tif", 4, 3, 1, gdal.GDT_Byte)
tif.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
tif.SetSpatialRef(wgs84)
band = tif.GetRasterBand(1)
band.SetDescription("landcover")
colors = gdal.ColorTable()
colors.SetColorEntry(1, (0, 100, 0, 255))
colors.SetColorEntry(2, (250, 230, 160, 255))
band.SetColorTable(colors)
band.WriteArray(__import__("numpy").array([[1, 1, 1, 2], [1, 1, 2, 2], [9, 9, 2, 0]], dtype="uint8"))
tif = None
# No data kept only beside the raster, and statistics QGIS once cached, approximate and wrong.
with open("landcover.tif.aux.xml", "w") as aux:
    aux.write('<PAMDataset><PAMRasterBand band="1"><NoDataValue>0</NoDataValue><Metadata><MDI key="STATISTICS_APPROXIMATE">YES</MDI><MDI key="STATISTICS_MAXIMUM">2</MDI><MDI key="STATISTICS_MINIMUM">1</MDI><MDI key="STATISTICS_MEAN">1.5</MDI><MDI key="STATISTICS_STDDEV">0.5</MDI></Metadata></PAMRasterBand></PAMDataset>')

gml = ogr.GetDriverByName("GML").CreateDataSource("roads.gml", options=["XSISCHEMA=OFF"])
roads = gml.CreateLayer("roads", wgs84, ogr.wkbLineString)
feature = ogr.Feature(roads.GetLayerDefn())
feature.SetGeometry(ogr.CreateGeometryFromWkt("LINESTRING (114.25 30.55, 114.35 30.62)"))
roads.CreateFeature(feature)
gml = None

blank = gdal.GetDriverByName("GTiff").Create("blank.tif", 3, 3, 1, gdal.GDT_Float32)
blank.SetGeoTransform([114, 0.01, 0, 31, 0, -0.01])
blank.SetSpatialRef(wgs84)
blank.GetRasterBand(1).SetNoDataValue(-1)
blank.GetRasterBand(1).Fill(-1)
blank = None

png = gdal.GetDriverByName("MEM").Create("", 2, 2, 3, gdal.GDT_Byte)
gdal.GetDriverByName("PNG").CreateCopy("photo.png", png)
`
  execFileSync(located.install.interpreter, ["-c", script, directory], {
    env: { ...process.env, ...Macos.environment(located.install) },
    stdio: ["ignore", "ignore", "pipe"],
  })
}
