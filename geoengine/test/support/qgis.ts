import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Python } from "../../src/qgis/python.ts"
import { Qgis } from "../../src/qgis/index.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { until } from "./common.ts"

export const darwin = process.platform === "darwin"

const plist = (identifier: string, version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
  `\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n` +
  `\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`

/** An app bundle shaped like QGIS's; `python` is the body of a shell script standing in for its interpreter. */
export const fakeApp = async (
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

export const mark = (payload: unknown) => `echo '${Python.MARKER}${JSON.stringify(payload)}'`

export const READY = mark({ python: "3.12.11", gdal: "3.13.3", qgis: "3.44.15-Solothurn", algorithms: 440 })

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

export const CATALOG = {
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
  excluded: [],
  vectorExtensions: ["gpkg", "shp", "geojson"],
}

/**
 * A fake interpreter, which reads its program from stdin: `probe` answers the probe script, `run` the run script,
 * `inspect` the survey of the data, `catalog` the listing of the algorithms.
 */
export const fake = (probe: string, run: string, catalog = mark(CATALOG), inspect = "exit 9") =>
  `program=$(cat)\n` +
  `case "$program" in *processing.run*) ${run} ;; *parameterTypes*) ${catalog} ;; ` +
  `*GT_IsSurface*) ${inspect} ;; *) ${probe} ;; esac`

type Response = Extract<Protocol.Outbound, { type: "response" }>

export const start = async (configured: string | undefined) => {
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
