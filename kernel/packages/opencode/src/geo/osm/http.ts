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
 * `node:https` rather than `fetch`, and the reason is structural: Net hands out
 * its in-process route as a Node agent (§3.3), because a dispatcher would mean
 * a dependency the target runtime cannot resolve. The route is carried PER
 * REQUEST rather than installed globally — a process-wide setting would reach
 * every other thing the kernel does, and the caller here is one module deciding
 * how its own traffic travels, not how the process does.
 *
 * Nothing here decides WHICH endpoint to use or what to do when one fails;
 * that is the client's business. This module only knows how to make one
 * request safely. --- */

export const USER_AGENT = "GeoCode-osm/1.0"

/**
 * The ceiling on a single response body.
 *
 * Counted while receiving, never from a header: the public instances answer
 * with chunked transfer encoding and send no length at all, so a header check
 * is not a weak guard but no guard whatsoever. A runaway query has to be cut
 * off mid-flight or it takes the process down with it.
 */
export const MAX_RESPONSE_BYTES = 200 * 1024 * 1024

export class OsmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly endpoint?: string,
    /** True when the body was cut off for exceeding the ceiling. */
    readonly oversized = false,
  ) {
    super(message)
    this.name = "OsmHttpError"
  }
}

export interface Request {
  readonly url: string
  readonly method?: "GET" | "POST"
  /** Form body for POST; the public query interface takes `data=<QL>`. */
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
 * One request, one route, with the size ceiling enforced as bytes arrive.
 *
 * Fails with `OsmHttpError` for anything the caller might want to fail over
 * from, and passes an abort straight through — a cancelled call is not a
 * failed endpoint and must not cost one.
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
      // The tunnel agent is built per request, so its sockets are ours to close.
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

/**
 * The request surface as a service.
 *
 * Same shape as Runtime's: the one place that touches the outside world sits
 * behind an interface, so the reliability layer above can be exercised against
 * scripted responses — failover, stickiness, soft failures — without a network.
 * The real path is proven by running against the real services.
 */
export interface Interface {
  readonly request: (input: Request) => Effect.Effect<Response, OsmHttpError | DOMException>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/OsmHttp") {}

export const use = serviceUse(Service)

const layer = Layer.succeed(Service, Service.of({ request }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
