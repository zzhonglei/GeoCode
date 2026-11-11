import assert from "node:assert/strict"
import { test } from "node:test"
import { type Duration, Effect, Fiber, Result } from "effect"
import { Runtime } from "../../src/runtime.ts"
import { alive, until } from "../support/common.ts"

const NODE = process.execPath

const quiet: Runtime.Ledger = { started: () => {}, ended: () => {} }

const run = (options: Runtime.Options, ledger = quiet) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* runtime.run(options)
      }),
    ).pipe(Effect.provide(Runtime.layer(ledger))),
  )

const node = (script: string, extra: Partial<Runtime.Options> = {}): Runtime.Options => ({
  command: NODE,
  args: ["-e", script],
  delivery: { mode: "collect" },
  clocks: { total: "10 seconds" },
  ...extra,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

const POSIX_ONLY = process.platform === "win32" && "Windows has no process groups or signals"

// A grandchild that keeps the task's output pipes open, and ends itself in case a failing test leaves it behind.
// A detached one is outside the task's process group, so ending the group leaves it running.
const spawnGrandchild = (detached = false) => `(() => {
  const grandchild = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: ${detached},
  })
  grandchild.unref()
  return grandchild.pid
})()`

test("an override replaces every spelling of a variable's name on Windows, and only the same spelling elsewhere", () => {
  const base = { Path: "C:\\Windows", HOME: "/home" }
  assert.deepEqual(Runtime.overlay(base, { PATH: "C:\\QGIS" }, "win32"), { HOME: "/home", PATH: "C:\\QGIS" })
  assert.deepEqual(Runtime.overlay(base, { PATH: "/qgis" }, "darwin"), {
    Path: "C:\\Windows",
    HOME: "/home",
    PATH: "/qgis",
  })
})

// Guards against what the user set for their own tools reaching QGIS or GeoCode's Python: another GDAL's data, another
// Python's packages, a PATH that finds other programs first.
test("a task keeps only the network, the account, the temporary directory and the system of the engine's environment", () => {
  const engine = {
    https_proxy: "http://proxy",
    NO_PROXY: "corp.example",
    SSL_CERT_FILE: "/ca.pem",
    HOME: "/home/u",
    TMPDIR: "/tmp/u",
    PATH: "/opt/homebrew/bin:/usr/bin",
    PYTHONPATH: "/elsewhere",
    GDAL_DATA: "/gdal",
    PROJ_DATA: "/proj",
    CONDA_PREFIX: "/conda",
    LANG: "zh_CN.UTF-8",
  }
  assert.deepEqual(Runtime.base(engine, "darwin"), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    https_proxy: "http://proxy",
    NO_PROXY: "corp.example",
    SSL_CERT_FILE: "/ca.pem",
    HOME: "/home/u",
    TMPDIR: "/tmp/u",
  })
  const windows = Runtime.base(
    { SystemRoot: "D:\\Win", Path: "C:\\conda", UserProfile: "C:\\Users\\u", PYTHONPATH: "x" },
    "win32",
  )
  assert.deepEqual(windows, {
    PATH: "D:\\Win\\System32;D:\\Win",
    SystemRoot: "D:\\Win",
    UserProfile: "C:\\Users\\u",
  })
})

test("a run is given the kept environment and its own variables", async () => {
  process.env.GEOENGINE_TEST_ENGINE_ONLY = "engine"
  try {
    const script = `console.log(JSON.stringify([process.env.GEOENGINE_TEST_ENGINE_ONLY, process.env.GEOENGINE_TEST_GIVEN, process.env.HOME]))`
    const given = { GEOENGINE_TEST_GIVEN: "given" }
    assert.deepEqual(JSON.parse((await run(node(script, { env: given }))).stdout), [
      null,
      "given",
      process.env.HOME ?? null,
    ])
  } finally {
    delete process.env.GEOENGINE_TEST_ENGINE_ONLY
  }
})

test("the total clock ends a run that outlives it and keeps what it wrote", async () => {
  const result = await run(
    node(`process.stdout.write("started"); setInterval(() => {}, 1000)`, { clocks: { total: "500 millis" } }),
  )
  assert.equal(result.reason, "timeout")
  assert.equal(result.stdout, "started")
})

test("the idle clock ends a silent run but not one that keeps writing", async () => {
  const silent = await run(
    node(`process.stdout.write("a"); setInterval(() => {}, 1000)`, { clocks: { idle: "500 millis" } }),
  )
  assert.equal(silent.reason, "idle")

  const chatty = await run(
    node(
      `let n = 0; const t = setInterval(() => { process.stdout.write("."); if (++n === 10) { clearInterval(t) } }, 150)`,
      { clocks: { idle: "500 millis" } },
    ),
  )
  assert.equal(chatty.reason, "exit")
  assert.equal(chatty.stdout, "..........")
})

test("an abort returns the output produced so far", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const started = Date.now()
  const result = await run(
    node(`process.stdout.write("partial"); setInterval(() => {}, 1000)`, { signal: controller.signal }),
  )
  assert.equal(result.reason, "abort")
  assert.equal(result.stdout, "partial")
  assert.ok(Date.now() - started < 3000)
})

test("a signal already aborted starts nothing", async () => {
  const controller = new AbortController()
  controller.abort()
  const started: number[] = []
  const result = await run(node(`process.stdout.write("ran")`, { signal: controller.signal }), {
    started: (pid) => void started.push(pid),
    ended: () => {},
  })
  assert.equal(result.reason, "abort")
  assert.deepEqual(started, [])
})

test("an abort ends the grandchildren too", async () => {
  const controller = new AbortController()
  let grandchild = 0
  const result = await run(
    node(`console.log(${spawnGrandchild()}); setInterval(() => {}, 1000)`, {
      delivery: {
        mode: "incremental",
        onChunk: (chunk) => {
          grandchild = Number(chunk.trim())
          controller.abort()
        },
      },
      signal: controller.signal,
    }),
  )
  assert.equal(result.reason, "abort")
  assert.ok(grandchild > 0)
  await settle()
  assert.equal(alive(grandchild), false)
})

test(
  "a clean exit ends what the task left running, without waiting out the settlement",
  { skip: POSIX_ONLY },
  async () => {
    const started = Date.now()
    const result = await run(node(`console.log(${spawnGrandchild()})`))
    assert.equal(result.reason, "exit")
    assert.equal(result.drainIncomplete, false)
    assert.ok(Date.now() - started < 3000)
    await settle()
    assert.equal(alive(Number(result.stdout.trim())), false)
  },
)

test("a task that ignores SIGTERM is killed once the grace period ends", { skip: POSIX_ONLY }, async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const started = Date.now()
  const result = await run(
    node(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`, {
      signal: controller.signal,
      grace: "500 millis",
    }),
  )
  assert.equal(result.reason, "abort")
  assert.equal(result.signal, "SIGKILL")
  assert.ok(Date.now() - started < 3000)
})

test("collect mode stops a run whose output passes the limit", async () => {
  const result = await run(
    node(`setInterval(() => process.stdout.write("x".repeat(1000)), 10)`, {
      delivery: { mode: "collect", limit: 5000 },
    }),
  )
  assert.equal(result.reason, "output-limit")
  assert.ok(result.stdout.length <= 5000)
  assert.equal(result.truncated, true)
})

test("incremental mode can hand stderr over too, saying which stream each chunk came from", async () => {
  const chunks: string[] = []
  const result = await run(
    node(`process.stdout.write("one"); setTimeout(() => process.stderr.write("problem"), 50)`, {
      delivery: {
        mode: "incremental",
        source: "all",
        onChunk: (chunk, stream) => void chunks.push(`${stream}:${chunk}`),
      },
    }),
  )
  assert.deepEqual(chunks, ["stdout:one", "stderr:problem"])
  assert.equal(result.stderr, "")
})

test("a consumer that throws ends the run, which fails with that error", async () => {
  let pid = 0
  const outcome = await run(
    node(`console.log("line"); setInterval(() => {}, 1000)`, {
      delivery: {
        mode: "incremental",
        onChunk: () => {
          throw new Error("unreadable progress")
        },
      },
    }),
    { started: (started) => void (pid = started), ended: () => {} },
  ).then(
    () => undefined,
    (error: Error) => error,
  )
  assert.equal(outcome?.message, "unreadable progress")
  await settle()
  assert.equal(alive(pid), false)
})

test("a task that exits without reading a large input does not bring the engine down", async () => {
  const result = await run(node(`process.exit(0)`, { input: "x".repeat(4 * 1024 * 1024) }))
  assert.equal(result.code, 0)
})

test("a missing executable fails at once when the run carries a signal", async () => {
  const started = Date.now()
  const outcome = await run({
    ...node(""),
    command: "/nonexistent/geoengine-test-binary",
    signal: new AbortController().signal,
  }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  assert.equal(outcome?.code, "ENOENT")
  assert.ok(Date.now() - started < 1000)
})

test("a task's process is reported ended when it exits, not when its pipes close", async () => {
  const started = Date.now()
  let ended = Infinity
  const result = await run(node(`console.log(${spawnGrandchild(true)})`), {
    started: () => {},
    ended: () => void (ended = Date.now() - started),
  })
  try {
    process.kill(Number(result.stdout.trim()), "SIGKILL")
  } catch {}
  assert.equal(result.drainIncomplete, true)
  assert.ok(ended < 2000, `reported after ${ended} ms`)
})

test("interrupting the run ends the process", async () => {
  let pid = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const fiber = yield* Effect.forkChild(runtime.run(node(`setInterval(() => {}, 1000)`)))
        yield* Effect.sleep("300 millis")
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(Runtime.layer({ started: (started) => void (pid = started), ended: () => {} }))),
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(pid > 0)
  assert.equal(alive(pid), false)
})

test("shutdown ends every running task, waits for them, and refuses later runs", async () => {
  const pids: number[] = []
  const [results, later] = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const fibers = yield* Effect.forEach([1, 2], () =>
          Effect.forkChild(runtime.run(node(`setInterval(() => {}, 1000)`))),
        )
        yield* Effect.sleep("300 millis")
        yield* runtime.shutdown()
        const ended = yield* Effect.forEach(fibers, Fiber.join)
        return [ended, yield* runtime.run(node(`process.exit(0)`)).pipe(Effect.flip)] as const
      }),
    ).pipe(Effect.provide(Runtime.layer({ started: (pid) => void pids.push(pid), ended: () => {} }))),
  )
  assert.deepEqual(
    results.map((result) => result.reason),
    ["abort", "abort"],
  )
  assert.equal(pids.length, 2)
  for (const pid of pids) assert.equal(alive(pid), false)
  assert.ok(later instanceof Runtime.ShuttingDown)
})

test("closing the runtime's scope ends the tasks still running", async () => {
  let pid = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        yield* Effect.forkDetach(runtime.run(node(`setInterval(() => {}, 1000)`)))
        yield* Effect.sleep("300 millis")
      }),
    ).pipe(Effect.provide(Runtime.layer({ started: (started) => void (pid = started), ended: () => {} }))),
  )
  assert.ok(pid > 0)
  assert.equal(alive(pid), false)
})

// A worker that answers each line as the line asks: `size` bytes of `fill` after a line naming them, or `raw` as it
// is, and then exits when asked to.
const ANSWERING = `require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const asked = JSON.parse(line)
  const answer = asked.raw !== undefined
    ? Buffer.from(asked.raw)
    : Buffer.concat([
        Buffer.from(JSON.stringify({ id: asked.id, bytes: asked.size }) + "\\n"),
        Buffer.alloc(asked.size, asked.fill),
      ])
  process.stdout.write(answer, () => asked.exit && process.exit(0))
})`

type Frame = readonly [header: unknown, bytes: Uint8Array]

/** Opens a worker, hands it and the answers it gives to `use`, and returns how it ended. */
const serve = (
  use: (worker: Runtime.Worker, frames: Frame[], runtime: Runtime.Interface) => Promise<void>,
  options: { script?: string; idle?: Duration.Input; ledger?: Runtime.Ledger; onFrame?: () => void } = {},
) => {
  const frames: Frame[] = []
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const worker = yield* runtime.worker({
          command: NODE,
          args: ["-e", options.script ?? ANSWERING],
          idle: options.idle ?? "10 seconds",
          onFrame: (header, bytes) => {
            frames.push([header, bytes])
            options.onFrame?.()
          },
        })
        yield* Effect.promise(() => use(worker, frames, runtime))
        return yield* Effect.result(worker.ended)
      }),
    ).pipe(Effect.provide(Runtime.layer(options.ledger ?? quiet))),
  )
}

const ask = (worker: Runtime.Worker, request: object) => worker.send(JSON.stringify(request))

// Guards the cutting of a worker's output into answers: bytes that hold line ends, an answer arriving in many pieces,
// several in one piece, and a line that names no bytes.
test("a worker's answers arrive whole and in order, however its output is cut", async () => {
  const large = 3 * 1024 * 1024
  const ended = await serve(async (worker, frames) => {
    ask(worker, { id: 1, size: 0, fill: 0 })
    ask(worker, { id: 2, size: large, fill: 0x0a })
    ask(worker, { raw: `{"id":3,"bytes":2}\nab{"id":4}\n{"id":5,"bytes":1}\nc` })
    await until(() => frames.length === 5, 5000, "the five answers")
    assert.deepEqual(
      frames.map(([header, bytes]) => [(header as { id: number }).id, bytes.length]),
      [
        [1, 0],
        [2, large],
        [3, 2],
        [4, 0],
        [5, 1],
      ],
    )
    assert.ok(frames[1][1].every((byte) => byte === 0x0a))
    assert.equal(Buffer.from(frames[2][1]).toString(), "ab")
    assert.equal(Buffer.from(frames[4][1]).toString(), "c")
    // Each answer's bytes are its own: a view into what arrived would carry the answers after it wherever it is sent.
    assert.equal(frames[2][1].buffer.byteLength, 2)
    worker.stop()
  })
  assert.ok(Result.isSuccess(ended))
  assert.equal(ended.success.reason, "abort")
})

// Guards a request made just before the clock runs out: were only answers to refresh it, the worker would be ended
// in the middle of that request.
test("the idle clock ends a worker left alone, but not one that is still being asked", async () => {
  const started = Date.now()
  const ended = await serve(
    async (worker) => {
      for (let n = 0; n < 8; n++) {
        worker.send("{}")
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    },
    { script: `process.stdin.on("data", () => {})`, idle: "500 millis" },
  )
  assert.ok(Result.isSuccess(ended))
  assert.equal(ended.success.reason, "idle")
  assert.ok(Date.now() - started >= 1600, `ended after ${Date.now() - started} ms`)
})

// Guards the requests waiting on a worker: skipping an output that is no answer would leave them waiting for good.
test("an output that is not an answer ends the worker, which fails", async () => {
  for (const raw of ["Warning: something\n", `{"bytes":-1}\n`, `{"bytes":"3"}\n`]) {
    let pid = 0
    const ended = await serve(async (worker) => ask(worker, { raw }), {
      ledger: { started: (started) => void (pid = started), ended: () => {} },
    })
    assert.ok(Result.isFailure(ended), raw)
    await settle()
    assert.equal(alive(pid), false)
  }
})

test("a worker that names more bytes than an answer may hold is ended before any of them is kept", async () => {
  const ended = await serve(async (worker) => ask(worker, { raw: `{"bytes":${2 ** 40}}\n` }))
  assert.ok(Result.isSuccess(ended))
  assert.equal(ended.success.reason, "output-limit")
})

// Thrown inside the handler of the process's output, it would otherwise end the engine.
test("a consumer of answers that throws ends the worker, which fails with that error", async () => {
  let pid = 0
  const ended = await serve(async (worker) => ask(worker, { id: 1, size: 0, fill: 0 }), {
    ledger: { started: (started) => void (pid = started), ended: () => {} },
    onFrame: () => {
      throw new Error("unreadable answer")
    },
  })
  assert.ok(Result.isFailure(ended))
  assert.equal(ended.failure.message, "unreadable answer")
  await settle()
  assert.equal(alive(pid), false)
})

test("a worker that fails with no one waiting on its end does not end the engine", async () => {
  let pid = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const worker = yield* runtime.worker({
          command: NODE,
          args: ["-e", ANSWERING],
          idle: "10 seconds",
          onFrame: () => {},
        })
        ask(worker, { raw: "no answer\n" })
        yield* Effect.promise(() => until(() => pid > 0 && !alive(pid), 5000, "the worker to end"))
        // A rejection no one handles is reported a turn of the event loop after it happens.
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
      }),
    ).pipe(Effect.provide(Runtime.layer({ started: (started) => void (pid = started), ended: () => {} }))),
  )
})
