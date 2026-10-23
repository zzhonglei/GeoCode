import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { alive } from "../support/common.ts"

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
  const response = async (id: number) => {
    await waitFor((message) => message.type === "response" && message.id === id)
    return sent.find((message): message is Response => message.type === "response" && message.id === id)!
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
  return { sent, deliver: (message: unknown) => deliver(message), waitFor, response, stop }
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

// Guards against a failure losing the code the shell server and the kernel decide by.
test("returns a method's failure as it is, and a defect as internal", async () => {
  const engine = await start()
  try {
    engine.deliver({ type: "request", id: 6, method: "probe.fail" })
    const failed = await engine.response(6)
    assert.equal(failed.ok === false && failed.error.code, "probe-failed")

    engine.deliver({ type: "request", id: 7, method: "probe.defect" })
    const defect = await engine.response(7)
    assert.equal(defect.ok === false && defect.error.code, "internal")
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

test("shutdown confirms only after cancelled requests have answered", async () => {
  const engine = await start([lingering])
  try {
    engine.deliver({ type: "request", id: 14, method: "lingering.wait" })
    engine.deliver({ type: "shutdown" })
    await engine.waitFor((message) => message.type === "shutdown-complete")
    const answered = engine.sent.findIndex((message) => message.type === "response" && message.id === 14)
    const confirmed = engine.sent.findIndex((message) => message.type === "shutdown-complete")
    assert.ok(answered >= 0 && answered < confirmed)
  } finally {
    await engine.stop()
  }
})
