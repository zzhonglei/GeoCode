import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { until } from "./common.ts"

export type Response = Extract<Protocol.Outbound, { type: "response" }>
type Progress = Extract<Protocol.Outbound, { type: "progress" }>

/**
 * An engine running `capabilities`, made for a temporary folder of its own that holds its machine.json, and spoken to
 * as the main process speaks to it: every message it sends is kept, in order, and requests go in numbered. Stopping it
 * removes the folder.
 */
export const start = async (
  name: string,
  capabilities: (directory: string) => readonly Engine.Capability[] | Promise<readonly Engine.Capability[]>,
  machine?: object,
) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `geoengine-${name}-`))
  const file = path.join(directory, "machine.json")
  if (machine !== undefined) await fs.writeFile(file, JSON.stringify(machine))
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(file))
  const fiber = Effect.runFork(
    Effect.scoped(Engine.run(transport, await capabilities(directory))).pipe(Effect.provide(layer)),
  )
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }

  /** The first message `find` matches, once the engine has sent it. */
  const waitFor = async (find: (message: Protocol.Outbound) => boolean, ms = 10000) => {
    await until(() => sent.some(find), ms, "a message")
    return sent.find(find)!
  }
  const response = async (id: number, ms = 10000) =>
    (await waitFor((message) => message.type === "response" && message.id === id, ms)) as Response
  const progress = (id: number) =>
    sent.flatMap((message) => (message.type === "progress" && message.id === id ? [(message as Progress).data] : []))
  /** The values the domain's status took, in order. */
  const states = <A>(domain: string) =>
    sent.flatMap((message) => (message.type === "status" && message.domain === domain ? [message.value as A] : []))
  /** The domain's status once it is none of `pending`. */
  const settled = async <A extends { status: string }>(domain: string, ms: number, pending = ["checking"]) => {
    const last = () => states<A>(domain).at(-1)?.status ?? pending[0]
    await until(() => !pending.includes(last()), ms, `${domain} to settle`)
    return states<A>(domain).at(-1)!
  }
  let nextId = 0
  const send = (method: string, params: unknown) => {
    nextId += 1
    deliver({ type: "request", id: nextId, method, params })
    return nextId
  }

  try {
    await until(() => sent.some((message) => message.type === "ready"), 10000, "the engine")
  } catch (error) {
    await stop()
    throw error
  }
  return {
    directory,
    machine: file,
    sent,
    deliver: (message: unknown) => deliver(message),
    waitFor,
    response,
    progress,
    states,
    settled,
    send,
    stop,
  }
}

/**
 * GeoCode's Python environment as the domains find it, with `base` for its interpreter: ready at once, or, given
 * `later`, being installed until that settles.
 */
export const pythonReady = (base: string, version: string, later?: Promise<void>): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const ready = { status: "ready", version, python: base, base }
    const writer = yield* status.register<unknown>(
      "python",
      later ? { status: "preparing", step: "installing" } : ready,
    )
    const token = yield* writer.claim()
    if (later) yield* Effect.forkScoped(Effect.promise(() => later).pipe(Effect.andThen(writer.commit(token, ready))))
    return { domain: "python", methods: {} }
  })
