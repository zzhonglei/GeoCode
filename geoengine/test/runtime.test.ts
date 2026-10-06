import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Fiber } from "effect"
import { Runtime } from "../src/runtime.ts"

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

test("collects output and the exit code", async () => {
  const result = await run(node(`process.stdout.write("out"); process.stderr.write("err"); process.exit(3)`))
  assert.equal(result.reason, "exit")
  assert.equal(result.code, 3)
  assert.equal(result.stdout, "out")
  assert.equal(result.stderr, "err")
  assert.equal(result.drainIncomplete, false)
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

test("incremental mode hands output to the consumer and keeps stderr", async () => {
  const chunks: string[] = []
  const result = await run(
    node(`process.stdout.write("one"); process.stderr.write("problem")`, {
      delivery: { mode: "incremental", onChunk: (chunk) => void chunks.push(chunk) },
    }),
  )
  assert.equal(chunks.join(""), "one")
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "problem")
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

test("output cut inside a character is kept, not dropped", async () => {
  const result = await run(node(`process.stdout.write(Buffer.from([0x61, 0xe4, 0xb8]))`))
  assert.equal(result.stdout.startsWith("a"), true)
  assert.ok(result.stdout.length > 1)
})

test("a missing executable fails at once", async () => {
  const started = Date.now()
  const outcome = await run({ ...node(""), command: "/nonexistent/geoengine-test-binary" }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  assert.equal(outcome?.code, "ENOENT")
  assert.ok(Date.now() - started < 1000)
})

test("a missing executable fails cleanly when the run also carries a signal", async () => {
  const outcome = await run({
    ...node(""),
    command: "/nonexistent/geoengine-test-binary",
    signal: new AbortController().signal,
  }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  assert.equal(outcome?.code, "ENOENT")
})

test("a process ended by a signal reports it", { skip: POSIX_ONLY }, async () => {
  const result = await run(node(`process.kill(process.pid, "SIGKILL")`))
  assert.equal(result.reason, "exit")
  assert.equal(result.signal, "SIGKILL")
})

test("the environment is laid over the engine's, and input reaches stdin", async () => {
  const result = await run(
    node(
      `process.stdin.on("data", (d) => process.stdout.write(d + ":" + process.env.GEOENGINE_TEST + ":" + Boolean(process.env.PATH)))`,
      { env: { GEOENGINE_TEST: "set" }, input: "hello" },
    ),
  )
  assert.equal(result.stdout, "hello:set:true")
})

test("every task process is reported when it starts and when it ends", async () => {
  const events: string[] = []
  const result = await run(node(`process.stdout.write(String(process.pid))`), {
    started: (pid) => void events.push(`start ${pid}`),
    ended: (pid) => void events.push(`end ${pid}`),
  })
  assert.deepEqual(events, [`start ${result.stdout}`, `end ${result.stdout}`])
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
