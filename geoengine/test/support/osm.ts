import fs from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../../src/config.ts"
import { Engine } from "../../src/engine.ts"
import { Osm } from "../../src/osm/index.ts"
import type { Protocol } from "../../src/protocol.ts"
import { Runtime } from "../../src/runtime.ts"
import { Status } from "../../src/status.ts"
import type { Transport } from "../../src/transport.ts"
import { SOURCE, until } from "./common.ts"

/**
 * What one of the fake services answers: JSON, or a status with a body of its own; or nothing at all, the request
 * held until the services close; or JSON sent in pieces, one every `every` milliseconds.
 */
export type Reply =
  | { readonly json: unknown }
  | { readonly status: number; readonly body: string }
  | { readonly silent: true }
  | { readonly trickle: unknown; readonly pieces: number; readonly every: number }

export interface Asked {
  readonly service: "overpass" | "nominatim" | "photon" | "wikidata"
  /** For Overpass, which instance in the order GeoEngine asks them; for the others, the path after the service. */
  readonly where: string
  readonly params: URLSearchParams
  /** Overpass's query. */
  readonly query: string
  readonly agent: string | undefined
  readonly at: number
}

export interface Handlers {
  readonly overpass?: (query: string, instance: number) => Reply
  readonly nominatim?: (where: string, params: URLSearchParams) => Reply
  readonly photon?: (params: URLSearchParams) => Reply
  readonly wikidata?: (params: URLSearchParams) => Reply
}

export const INSTANCES = 3

/** When Overpass's data is from, as a current instance answers: the day before. */
export const fresh = () => new Date(Date.now() - 86400000).toISOString().replace(/\.\d+Z$/, "Z")

/** An Overpass answer holding the elements. */
export const answer = (elements: readonly unknown[], extra: object = {}): Reply => ({
  json: { osm3s: { timestamp_osm_base: fresh() }, elements, ...extra },
})

/** Overpass's answer to `out count`, one per statement counted. */
export const counts = (...totals: readonly number[]): Reply =>
  answer(
    totals.map((total) => ({
      type: "count",
      id: 0,
      tags: { nodes: String(total), ways: "0", relations: "0", total: String(total) },
    })),
  )

const empty: Reply = { json: [] }

/** The fake services on a port of their own, recording every request, with the addresses GeoEngine is given. */
export const serve = async (handlers: Handlers) => {
  const asked: Asked[] = []
  const server = http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")))
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://localhost")
      const [, service, ...rest] = url.pathname.split("/")
      const params = url.searchParams
      const query = new URLSearchParams(body).get("data") ?? ""
      const where = rest.join("/")
      asked.push({
        service: service as Asked["service"],
        where,
        params,
        query,
        agent: request.headers["user-agent"],
        at: Date.now(),
      })
      const reply =
        service === "overpass"
          ? (handlers.overpass?.(query, Number(rest[0])) ?? answer([]))
          : service === "nominatim"
            ? (handlers.nominatim?.(where, params) ?? empty)
            : service === "photon"
              ? (handlers.photon?.(params) ?? { json: { features: [] } })
              : (handlers.wikidata?.(params) ?? { json: {} })
      if ("silent" in reply) return
      if ("trickle" in reply) {
        const text = JSON.stringify(reply.trickle)
        const size = Math.ceil(text.length / reply.pieces)
        response.writeHead(200, { "Content-Type": "application/json" })
        const send = (at: number) => {
          if (at >= text.length) return void response.end()
          response.write(text.slice(at, at + size))
          setTimeout(() => send(at + size), reply.every)
        }
        return send(0)
      }
      if ("json" in reply) {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(JSON.stringify(reply.json))
      } else {
        response.writeHead(reply.status, { "Content-Type": "text/html" })
        response.end(reply.body)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const services: Osm.Services = {
    overpass: Array.from({ length: INSTANCES }, (_, index) => `${at}/overpass/${index}/interpreter`),
    nominatim: `${at}/nominatim/`,
    photon: `${at}/photon/`,
    wikidata: `${at}/wikidata/`,
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // A request answered with silence would otherwise keep the server open.
      server.closeAllConnections()
    })
  return { asked, services, close }
}

type Response = Extract<Protocol.Outbound, { type: "response" }>

/**
 * An engine with GeoCode's Python environment ready on `python`, which runs geocodekit from its source, and the OSM
 * module asking the fake services, stopping a call after `stall` seconds without progress when given. Requests to them
 * go direct: a proxy in the tests' own environment would take them elsewhere.
 */
export const start = async (python: string, services: Osm.Services, stall?: number) => {
  process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost"
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-osm-"))
  const wrapper = path.join(directory, "python")
  // No bytecode beside the sources: the package's own folder is not the tests' to write in.
  const preamble = `import sys; sys.dont_write_bytecode = True; sys.path[:0] = [${JSON.stringify(SOURCE)}]`
  await fs.writeFile(wrapper, `#!/bin/sh\n{ echo '${preamble}'; cat; } | '${python}' "$@"\n`)
  await fs.chmod(wrapper, 0o755)
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const environment: Engine.Capability = Effect.gen(function* () {
    const status = yield* Status.Service
    const writer = yield* status.register<unknown>("python", { status: "ready", version: "3.13", base: wrapper })
    yield* writer.claim()
    return { domain: "python", methods: {} }
  })
  const machine = path.join(directory, "machine.json")
  const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(machine))
  const fiber = Effect.runFork(
    Effect.scoped(Engine.run(transport, [environment, Osm.capability(services, stall)])).pipe(Effect.provide(layer)),
  )
  let nextId = 0
  const send = (method: string, params: object) => {
    nextId += 1
    deliver({ type: "request", id: nextId, method: `osm.${method}`, params })
    return nextId
  }
  const response = async (id: number, ms = 60000) => {
    const find = () => sent.find((message): message is Response => message.type === "response" && message.id === id)
    await until(() => find() !== undefined, ms, `the response to ${id}`)
    return find()!
  }
  const call = async (method: string, params: object) => response(send(method, params))
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }
  await until(() => sent.some((message) => message.type === "ready"), 10000, "the engine")
  return { directory, sent, send, response, call, cancel: (id: number) => deliver({ type: "cancel", id }), stop }
}
