import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import type { Protocol } from "../src/protocol.ts"
import { Runtime } from "../src/runtime.ts"
import { Status } from "../src/status.ts"
import type { Transport } from "../src/transport.ts"

const probe: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  const runtime = yield* Runtime.Service
  const writer = yield* status.register("probe", { status: "checking" })
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.sleep("20 millis")
      yield* writer.commit(yield* writer.claim(), { status: "ready" })
    }),
  )
  return {
    domain: "probe",
    methods: {
      echo: (params) => Effect.succeed(params),
      fail: () => Effect.fail(new Engine.Failure({ code: "probe-failed", message: "asked to fail" })),
      defect: () => Effect.die(new Error("boom")),
      unsendable: () => Effect.succeed({ callback: () => {} }),
      ticks: (_params, context) =>
        runtime
          .run({
            command: process.execPath,
            args: ["-e", `console.log(process.pid); setInterval(() => console.log("tick"), 100)`],
            delivery: { mode: "incremental", onChunk: (chunk) => context.progress(chunk) },
            clocks: { idle: "10 seconds" },
            signal: context.signal,
          })
          .pipe(
            Effect.map((result) => ({ reason: result.reason })),
            Effect.orDie,
          ),
    },
  }
})

const broken: Engine.Capability = Effect.die(new Error("could not start"))

const unsendableStatus: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  yield* status.register("unsendable", { check: () => {} })
  return { domain: "unsendable", methods: {} }
})

// Guards against shutdown confirming before a request that outlives its cancel has answered.
const lingering: Engine.Capability = Effect.succeed({
  domain: "lingering",
  methods: { wait: () => Effect.sleep("300 millis").pipe(Effect.as("finished")) },
})

type Response = Extract<Protocol.Outbound, { type: "response" }>

const start = async (capabilities: readonly Engine.Capability[] = [probe]) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-engine-"))
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    // Guards against a value the channel cannot carry going unanswered, as Electron's postMessage throws on it.
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const layer = Layer.mergeAll(
    Runtime.layer(Engine.ledger(transport)),
    Status.layer,
    Config.layer(path.join(directory, "machine.json")),
  )
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, capabilities)).pipe(Effect.provide(layer)))

  const waitFor = async (find: (message: Protocol.Outbound) => boolean) => {
    for (let elapsed = 0; elapsed < 5000; elapsed += 20) {
      const found = sent.find(find)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("timed out waiting for a message")
  }
  const responses = (id: number) =>
    sent.filter((message): message is Response => message.type === "response" && message.id === id)
  const response = async (id: number) => {
    await waitFor((message) => message.type === "response" && message.id === id)
    return responses(id)[0]!
  }
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    await waitFor((message) => message.type === "ready")
  } catch (error) {
    await stop()
    throw error
  }
  return { sent, deliver: (message: unknown) => deliver(message), waitFor, response, responses, stop }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidOf = (sent: Protocol.Outbound[], id: number) => {
  const first = sent.find((message) => message.type === "progress" && message.id === id)
  return Number(String(first?.type === "progress" && first.data).split("\n")[0])
}

test("every domain's first value reaches the main process, then each change", async () => {
  const engine = await start()
  try {
    await engine.waitFor(
      (message) => message.type === "status" && (message.value as { status: string }).status === "ready",
    )
    assert.deepEqual(
      engine.sent
        .filter((message) => message.type === "status")
        .map((message) => message.type === "status" && message.value),
      [{ status: "checking" }, { status: "ready" }],
    )
  } finally {
    await engine.stop()
  }
})

test("answers a request by its id, and refuses an unknown method", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 1, method: "probe.echo", params: { a: 1 } })
    assert.deepEqual(await engine.response(1), {
      type: "response",
      id: 1,
      cancelled: false,
      ok: true,
      result: { a: 1 },
    })

    engine.deliver({ type: "request", id: 2, method: "probe.missing" })
    const missing = await engine.response(2)
    assert.equal(missing.ok === false && missing.error.code, "unknown-method")
  } finally {
    await engine.stop()
  }
})

test("a request reusing a running id is ignored, and the running one is still answered", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 3, method: "probe.ticks" })
    await engine.waitFor((message) => message.type === "progress" && message.id === 3)
    engine.deliver({ type: "request", id: 3, method: "probe.echo", params: "second" })
    engine.deliver({ type: "cancel", id: 3 })
    const answer = await engine.response(3)
    assert.deepEqual(answer.ok && answer.result, { reason: "abort" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(engine.responses(3).length, 1)
  } finally {
    await engine.stop()
  }
})

test("a malformed request that carries an id is answered; other malformed messages are ignored", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 4, method: 7 })
    const malformed = await engine.response(4)
    assert.equal(malformed.ok === false && malformed.error.code, "malformed")

    engine.deliver("nonsense")
    engine.deliver({ type: "request", id: "not a number" })
    engine.deliver({ type: "request", id: 5, method: "probe.echo", params: "still here" })
    assert.equal((await engine.response(5)).ok, true)
  } finally {
    await engine.stop()
  }
})

test("returns a method's failure as it is, a defect as internal, and an unsendable result as internal", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 6, method: "probe.fail" })
    const failed = await engine.response(6)
    assert.equal(failed.ok === false && failed.error.code, "probe-failed")

    engine.deliver({ type: "request", id: 7, method: "probe.defect" })
    const defect = await engine.response(7)
    assert.equal(defect.ok === false && defect.error.code, "internal")

    engine.deliver({ type: "request", id: 8, method: "probe.unsendable" })
    const unsendable = await engine.response(8)
    assert.equal(unsendable.ok === false && unsendable.error.code, "internal")
  } finally {
    await engine.stop()
  }
})

test("streams progress, and a cancel stops the task and answers marked as cancelled", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 9, method: "probe.ticks" })
    await engine.waitFor(
      (message) => message.type === "progress" && message.id === 9 && String(message.data).includes("tick"),
    )
    const pid = pidOf(engine.sent, 9)
    engine.deliver({ type: "cancel", id: 9 })
    assert.deepEqual(await engine.response(9), {
      type: "response",
      id: 9,
      cancelled: true,
      ok: true,
      result: { reason: "abort" },
    })
    assert.equal(alive(pid), false)
    assert.deepEqual(
      engine.sent.filter((message) => message.type === "task"),
      [
        { type: "task", event: "start", pid },
        { type: "task", event: "end", pid },
      ],
    )
  } finally {
    await engine.stop()
  }
})

test("shutdown ends every running task before confirming, and refuses new requests", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 10, method: "probe.ticks" })
    await engine.waitFor((message) => message.type === "progress" && message.id === 10)
    const pid = pidOf(engine.sent, 10)
    engine.deliver({ type: "shutdown" })
    await engine.waitFor((message) => message.type === "shutdown-complete")
    assert.equal(alive(pid), false)

    engine.deliver({ type: "request", id: 11, method: "probe.echo" })
    const refused = await engine.response(11)
    assert.equal(refused.ok === false && refused.error.code, "shutting-down")
  } finally {
    await engine.stop()
  }
})

test("a capability that fails to start is skipped and the others still work", async () => {
  const engine = await start([broken, probe])
  try {
    engine.deliver({ type: "request", id: 12, method: "probe.echo", params: 1 })
    assert.equal((await engine.response(12)).ok, true)
  } finally {
    await engine.stop()
  }
})

test("a status value the channel cannot carry does not stop the other domains' statuses", async () => {
  const engine = await start([unsendableStatus, probe])
  try {
    await engine.waitFor(
      (message) => message.type === "status" && (message.value as { status?: string }).status === "ready",
    )
  } finally {
    await engine.stop()
  }
})

test("shutdown confirms only after cancelled requests have answered, and confirms again when asked again", async () => {
  const engine = await start([lingering])
  try {
    engine.deliver({ type: "request", id: 14, method: "lingering.wait" })
    engine.deliver({ type: "shutdown" })
    await engine.waitFor((message) => message.type === "shutdown-complete")
    const answered = engine.sent.findIndex((message) => message.type === "response" && message.id === 14)
    const confirmed = engine.sent.findIndex((message) => message.type === "shutdown-complete")
    assert.ok(answered >= 0 && answered < confirmed)

    engine.deliver({ type: "shutdown" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(engine.sent.filter((message) => message.type === "shutdown-complete").length, 2)
  } finally {
    await engine.stop()
  }
})

test("closing the engine ends the requests and tasks still running", async () => {
  const engine = await start()
  let pid = 0
  try {
    engine.deliver({ type: "request", id: 13, method: "probe.ticks" })
    await engine.waitFor((message) => message.type === "progress" && message.id === 13)
    pid = pidOf(engine.sent, 13)
  } finally {
    await engine.stop()
  }
  assert.equal(alive(pid), false)
})
