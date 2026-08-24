export * as OsmHttp from "./http"

import https from "node:https"
import { URL } from "node:url"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { NetRoute } from "../net/route"
import type { NetTypes } from "../net/types"

/* --- GeoCode: the HTTP floor of the OSM module (docs/GEOKERNEL.md §6.3).
 *
 * `node:https` rather than `fetch`, because Net hands its route out as a Node agent (§3.3) and it is worn per
 * request; which endpoint to use and what to do when one fails belong to the client above. --- */

export const USER_AGENT = "GeoCode-osm/1.0"

/**
 * The ceiling on one response body, counted while receiving rather than read from a header: the public instances
 * answer chunked and send no length at all, so a header check would be no guard whatsoever (§6.3 流式字节护栏).
 */
export const MAX_RESPONSE_BYTES = 200 * 1024 * 1024

export class OsmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly endpoint?: string,
    readonly oversized = false,
  ) {
    super(message)
    this.name = "OsmHttpError"
  }
}

export interface Request {
  readonly url: string
  readonly method?: "GET" | "POST"
  /** Sent as `application/x-www-form-urlencoded`, which is how the Overpass interface takes its `data=<QL>`. */
  readonly body?: string
  readonly route: NetTypes.Route
  readonly timeoutMs: number
  readonly abort?: AbortSignal
}

export interface Response {
  readonly status: number
  readonly body: string
}

/**
 * One request over one route, with the ceiling enforced as bytes arrive. An abort surfaces as `DOMException` and
 * everything else as `OsmHttpError`, which is how the caller tells a cancelled call from a failed endpoint.
 */
export function request(input: Request): Effect.Effect<Response, OsmHttpError | DOMException> {
  return Effect.callback<Response, OsmHttpError | DOMException>((resume) => {
    if (input.abort?.aborted) {
      resume(Effect.fail(new DOMException("aborted", "AbortError")))
      return
    }

    let settled = false
    const finish = (effect: Effect.Effect<Response, OsmHttpError | DOMException>) => {
      if (settled) return
      settled = true
      cleanup()
      resume(effect)
    }

    const url = new URL(input.url)
    const method = input.method ?? "GET"
    const headers: Record<string, string> = { "User-Agent": USER_AGENT }
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
      headers["Content-Length"] = String(Buffer.byteLength(input.body))
    }

    const agent = NetRoute.agent(input.route, input.timeoutMs)
    const outgoing = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
        timeout: input.timeoutMs,
      },
      (incoming) => {
        const chunks: Buffer[] = []
        let total = 0
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > MAX_RESPONSE_BYTES) {
            incoming.destroy()
            finish(
              Effect.fail(
                new OsmHttpError(
                  `the response passed ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB while still arriving; split the request into smaller areas`,
                  incoming.statusCode,
                  input.url,
                  true,
                ),
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        incoming.on("end", () =>
          finish(Effect.succeed({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })),
        )
        incoming.on("error", (error) => finish(Effect.fail(new OsmHttpError(error.message, undefined, input.url))))
      },
    )

    outgoing.on("timeout", () => {
      outgoing.destroy()
      finish(Effect.fail(new OsmHttpError(`no answer within ${input.timeoutMs}ms`, undefined, input.url)))
    })
    outgoing.on("error", (error) => finish(Effect.fail(new OsmHttpError(error.message, undefined, input.url))))

    const onAbort = () => {
      outgoing.destroy()
      finish(Effect.fail(new DOMException("aborted", "AbortError")))
    }
    input.abort?.addEventListener("abort", onAbort, { once: true })

    function cleanup() {
      input.abort?.removeEventListener("abort", onAbort)
      // A tunnel agent is built for this request alone, so its sockets are ours to close; a direct route has none.
      agent?.destroy()
    }

    if (input.body !== undefined) outgoing.write(input.body)
    outgoing.end()

    return Effect.sync(() => {
      outgoing.destroy()
      cleanup()
    })
  })
}

export interface Interface {
  readonly request: (input: Request) => Effect.Effect<Response, OsmHttpError | DOMException>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/OsmHttp") {}

export const use = serviceUse(Service)

const layer = Layer.succeed(Service, Service.of({ request }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
