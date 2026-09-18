import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "@/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { serveUIEffect } from "@/server/shared/ui"
import { testEffect } from "./lib/effect"

/* GeoCode: a merge can bring back the catch-all that fetches the web UI from app.opencode.ai (docs/KERNEL.md §6
 * item 7). */

const fsUtilLayer = AppNodeBuilder.build(FSUtil.node)
const it = testEffect(Layer.mergeAll(fsUtilLayer, RuntimeFlags.layer()))

const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

function catchAll(sent: string[], disableEmbeddedWebUi: boolean) {
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push(`${request.method} ${request.url}`)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("<html>upstream</html>")))
    }),
  )
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const http = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client: http, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(
        authorizationRouterMiddleware.layer.pipe(
          Layer.provide(ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })),
        ),
      ),
      Layer.provide([fsUtilLayer, client, RuntimeFlags.layer({ disableEmbeddedWebUi }), HttpServer.layerServices]),
    ),
    { disableLogger: true },
  ).handler
  return (url: string, init: RequestInit) =>
    Effect.promise(() =>
      Promise.resolve(handler(new Request(new URL(url, "http://localhost"), init), HttpApiApp.context)),
    )
}

const requests: Array<[string, RequestInit]> = [
  ["/", { headers: { authorization } }],
  ["/magic-prompts", { headers: { authorization, accept: "application/json" } }],
  [
    "/config/plugins/entry",
    { method: "POST", headers: { authorization, "content-type": "application/json" }, body: '{"spec":"probe"}' },
  ],
  // Public: reaches the catch-all without a credential.
  ["/site.webmanifest", {}],
]

describe("GeoCode: HTTP API catch-all", () => {
  for (const disableEmbeddedWebUi of [false, true]) {
    it.live(`answers 404 without reaching the network (disableEmbeddedWebUi: ${disableEmbeddedWebUi})`, () =>
      Effect.gen(function* () {
        const sent: string[] = []
        const request = catchAll(sent, disableEmbeddedWebUi)
        for (const [url, init] of requests) {
          const response = yield* request(url, init)
          expect(response.status).toBe(404)
        }
        expect(sent).toEqual([])
      }),
    )
  }

  test("the server's catch-all route dispatches to the guarded function", () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/server/routes/instance/httpapi/server.ts"), "utf8")
    const route = source.indexOf('router.add("*", "/*"')
    expect(route).toBeGreaterThan(-1)
    expect(source.indexOf("serveUIEffect(request", route)).toBeGreaterThan(route)
  })
})
