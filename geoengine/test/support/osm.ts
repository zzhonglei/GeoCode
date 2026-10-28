import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Osm } from "../../src/osm/index.ts"
import { SOURCE, pythonWith } from "./common.ts"
import { start as engineStart, pythonReady } from "./engine.ts"

/**
 * What one of the fake services answers: JSON, or a status with a body of its own; or nothing at all, the request
 * held until the services close; or JSON sent in pieces, one every `every` milliseconds; or another reply, `after`
 * milliseconds.
 */
export type Reply =
  | { readonly json: unknown }
  | { readonly status: number; readonly body: string }
  | { readonly silent: true }
  | { readonly trickle: unknown; readonly pieces: number; readonly every: number }
  | { readonly after: number; readonly reply: Reply }

export interface Asked {
  readonly service: "overpass" | "nominatim" | "photon" | "wikidata"
  /**
   * For Overpass, the instance's place in the list GeoEngine is given and "/interpreter"; for the others, the path
   * after the service.
   */
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

/** Whether a query is the probe that finds an instance free, rather than one a call asks for its own sake. */
export const isProbe = (query: string) => query.includes("node(1);out ids;")

/** The Overpass instance a request went to, by its place in the list. */
export const instanceOf = (request: Asked) => Number(request.where.split("/")[0])

/** The requests that asked an Overpass instance a call's own query, not a probe. */
export const queriesOf = (asked: readonly Asked[]) =>
  asked.filter((request) => request.service === "overpass" && !isProbe(request.query))

/** What the engine sent, as the tests read it. */
type Sent = readonly { type: string; id?: number; data?: unknown }[]

/** The progress of one kind the engine passed on, in order. */
export const told = (sent: Sent, type: string) =>
  sent.filter((message) => message.type === "progress" && (message.data as { osm: { type: string } }).osm.type === type)

/** What each call's row was told it waits on, in order. */
export const waitedOn = (sent: Sent) =>
  told(sent, "server")
    .map((message) => message.data as { osm: { asking: boolean; arriving: boolean; busy: boolean } })
    .map(({ osm: { asking, arriving, busy } }) => ({ asking, arriving, busy }))

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

const respond = (response: http.ServerResponse, reply: Reply): void => {
  if ("silent" in reply) return
  if ("after" in reply) return void setTimeout(() => respond(response, reply.reply), reply.after)
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
}

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
      respond(response, reply)
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

/**
 * An engine with GeoCode's Python environment ready on `python`, which runs geocodekit from its source, and the OSM
 * module asking the fake services, waiting as `timing` says where it differs from the app, and keeping its lock files
 * in a folder of its own. Requests to the services go direct: a proxy in the tests' own environment would take them
 * elsewhere, so the variables saying so are set while the engine runs and put back as they were when it stops.
 */
export const start = async (python: string, services: Osm.Services, timing: Partial<Osm.Timing> = {}) => {
  const inherited = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
  process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost"
  const restore = () => {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const engine = await engineStart("osm", async (directory) => [
    pythonReady(await pythonWith(path.join(directory, "python"), python, [SOURCE]), "3.13"),
    Osm.capability(path.join(directory, "locks"), services, { ...Osm.TIMING, ...timing }),
  ]).catch((error) => {
    restore()
    throw error
  })
  const send = (method: string, params: object) => engine.send(`osm.${method}`, params)
  const response = (id: number, ms = 60000) => engine.response(id, ms)
  return {
    ...engine,
    send,
    response,
    call: async (method: string, params: object) => response(send(method, params)),
    cancel: (id: number) => engine.deliver({ type: "cancel", id }),
    stop: () => engine.stop().finally(restore),
  }
}
