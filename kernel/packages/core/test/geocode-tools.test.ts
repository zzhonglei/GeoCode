import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { GeoTools } from "@opencode/core/geocode/tools"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const TOKEN = "kernel-callback-token"
const sessionID = Session.ID.make("ses_geocode_tools_test")

const assertions: Permission.AssertInput[] = []
const calls: Array<{ readonly authorization: string | null; readonly body: unknown }> = []
let answer = (_body: { method: string; params: Record<string, unknown> }): string[] => [
  JSON.stringify({ type: "result", ok: true, result: { text: "QGIS 4.2.3\n\nBuffer (native:buffer)" } }),
]

let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  // Stands in for the shell server's geo tool route.
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/api/geocode/geo-tool") return new Response("not found", { status: 404 })
      const body = (await request.json()) as { method: string; params: Record<string, unknown> }
      calls.push({ authorization: request.headers.get("authorization"), body })
      return new Response(answer(body).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } })
    },
  })
  process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${server.port}/api/openchamber/agent-tool`
  process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = TOKEN
})
afterAll(() => {
  server.stop(true)
  delete process.env.OPENCHAMBER_AGENT_TOOL_URL
  delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
})

const PROJECT = AbsolutePath.make(path.join(path.parse(process.cwd()).root, "geocode-test-project"))

const geoToolsNode = makeLocationNode({
  name: "test/geocode-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GeoTools.Plugin)),
  deps: [Tool.node, Permission.node, FileAccess.node],
})
let refused: string | undefined
/** Holds every asking until it is done, as a user who has not answered yet does. */
let pending: Deferred.Deferred<void> | undefined
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(pending ? Deferred.await(pending) : Effect.void),
      Effect.andThen(
        input.action === refused
          ? Effect.fail(
              new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
            )
          : Effect.void,
      ),
    ),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, geoToolsNode]), [
    Permission.node.replace(permission),
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory: PROJECT })))),
  ]),
)

const reset = () => {
  assertions.length = 0
  calls.length = 0
  refused = undefined
  pending = undefined
}

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-qgisdoc", name: "qgisdoc", input },
})

describe("GeoCode: qgisdoc", () => {
  it.effect("is on the tool list itself, not inside Code Mode, and asks the way grep asks", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("qgisdoc")
      const result = yield* executeTool(registry, call({ action: "help", algorithm: "native:buffer" }))
      expect(result).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "QGIS 4.2.3\n\nBuffer (native:buffer)" }],
      })
      expect(assertions).toMatchObject([{ sessionID, action: "qgisdoc", resources: ["native:buffer"], save: ["*"] }])
      // Guards against the call reaching GeoEngine without the kernel's token, or with other parameters than asked.
      expect(calls).toEqual([
        {
          authorization: `Bearer ${TOKEN}`,
          body: { method: "qgis.doc", params: { action: "help", algorithm: "native:buffer" } },
        },
      ])
    }),
  )

  it.effect("tells GeoAgent what to do when QGIS is not ready", () =>
    Effect.gen(function* () {
      reset()
      answer = () => [
        JSON.stringify({ type: "progress", data: { percent: 1 } }),
        JSON.stringify({
          type: "result",
          ok: false,
          error: { code: "not-ready", message: "QGIS is not configured. Ask the user for the location of their QGIS." },
        }),
      ]
      const result = yield* executeTool(yield* Tool.Service, call({ action: "groups", algorithm: "native:buffer" }))
      expect(result.status).toBe("error")
      expect(JSON.stringify(result.error)).toContain("QGIS is not configured. Ask the user for the location")
      // Guards against asking about a field the action does not use.
      expect(assertions).toMatchObject([{ resources: ["groups"] }])
    }),
  )

  // Guards against GeoAgent reading GeoCode's internals, which it can do nothing with.
  it.effect("tells GeoAgent only what to do when GeoCode cannot answer", () =>
    Effect.gen(function* () {
      reset()
      const url = process.env.OPENCHAMBER_AGENT_TOOL_URL
      delete process.env.OPENCHAMBER_AGENT_TOOL_URL
      const outside = yield* executeTool(yield* Tool.Service, call({ action: "groups" }))
      process.env.OPENCHAMBER_AGENT_TOOL_URL = url
      expect(outside.error?.message).toBe(
        "The QGIS tools are not available right now. Tell the user; restarting GeoCode may fix it.",
      )
      expect(calls).toEqual([])

      answer = () => [
        JSON.stringify({
          type: "result",
          ok: false,
          error: { code: "catalog-failed", message: "Traceback: boom", details: { stderr: "Traceback: boom" } },
        }),
      ]
      const listing = yield* executeTool(yield* Tool.Service, call({ action: "groups" }))
      expect(listing.error?.message).toBe("QGIS could not list its algorithms. Tell the user.")
    }),
  )
})

const read = (input: Record<string, unknown>, session = sessionID) => ({
  sessionID: session,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-readgeodata", name: "readgeodata", input },
})

const result = (value: unknown) => [JSON.stringify({ type: "result", ok: true, result: value })]

describe("GeoCode: readgeodata", () => {
  it.effect("asks as read asks, then has GeoEngine read the file at its absolute path", () =>
    Effect.gen(function* () {
      reset()
      answer = () => result({ text: "county.shp: vector, ESRI Shapefile" })
      const registry = yield* Tool.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("readgeodata")
      const inside = yield* executeTool(registry, read({ path: "data/county.shp", layer: "county", limit: 5 }))
      expect(inside).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "county.shp: vector, ESRI Shapefile" }],
      })
      expect(assertions).toMatchObject([{ action: "read", resources: ["data/county.shp"], save: ["*"] }])
      expect(calls).toEqual([
        {
          authorization: `Bearer ${TOKEN}`,
          body: {
            method: "qgis.read",
            params: { path: path.join(PROJECT, "data/county.shp"), layer: "county", limit: 5 },
          },
        },
      ])

      reset()
      const outside = path.join(path.parse(PROJECT).root, "elsewhere", "dem.tif")
      yield* executeTool(registry, read({ path: outside }))
      // Guards against reading outside the project without asking for its directory first, as read asks.
      expect(assertions.map((input) => [input.action, input.resources])).toEqual([
        ["external_directory", [path.join(path.dirname(outside), "*")]],
        ["read", [outside]],
      ])
    }),
  )

  it.effect("reads nothing when the read rules refuse", () =>
    Effect.gen(function* () {
      reset()
      refused = "read"
      const refusal = yield* executeTool(yield* Tool.Service, read({ path: ".env.gpkg" }))
      expect(refusal.status).toBe("error")
      expect(calls).toEqual([])
    }),
  )

  it.effect("asks once a session about a dataset GeoAgent looks at again", () =>
    Effect.gen(function* () {
      reset()
      answer = () => result({ text: "county.shp: vector, ESRI Shapefile" })
      const registry = yield* Tool.Service
      const first = Session.ID.make("ses_geocode_tools_once")
      const second = Session.ID.make("ses_geocode_tools_twice")
      const outside = path.join(path.parse(PROJECT).root, "survey", "county.shp")
      yield* executeTool(registry, read({ path: outside }, first))
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
      yield* executeTool(registry, read({ path: outside, offset: 4 }, first))
      yield* executeTool(registry, read({ path: outside, layer: "county" }, first))
      // Guards against asking again for a dataset already allowed, while still reading it each time.
      expect(assertions).toHaveLength(2)
      expect(calls).toHaveLength(3)
      yield* executeTool(registry, read({ path: path.join(path.dirname(outside), "roads.shp") }, first))
      yield* executeTool(registry, read({ path: outside }, second))
      // Guards against one approval reaching another file, or another session.
      expect(assertions).toHaveLength(6)

      reset()
      refused = "read"
      const third = Session.ID.make("ses_geocode_tools_refused")
      expect((yield* executeTool(registry, read({ path: outside }, third))).status).toBe("error")
      refused = undefined
      yield* executeTool(registry, read({ path: outside }, third))
      // Guards against remembering a refusal as an approval.
      expect(assertions.map((input) => input.action)).toEqual([
        "external_directory",
        "read",
        "external_directory",
        "read",
      ])
    }),
  )

  it.effect("asks once about a dataset two calls read side by side, and shares a refusal without keeping it", () =>
    Effect.gen(function* () {
      reset()
      answer = () => result({ text: "dem.tif: raster, GeoTIFF" })
      const registry = yield* Tool.Service
      const outside = path.join(path.parse(PROJECT).root, "survey", "dem.tif")
      const together = (session: Session.ID) =>
        Effect.gen(function* () {
          pending = yield* Deferred.make<void>()
          const both = yield* Effect.forkChild(
            Effect.all(
              [
                executeTool(registry, read({ path: outside }, session)),
                executeTool(registry, read({ path: outside, preview: true }, session)),
              ],
              { concurrency: 2 },
            ),
          )
          // Both calls are under way while the user has yet to answer the one asking.
          for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          yield* Deferred.succeed(pending, undefined)
          return yield* Fiber.join(both)
        })

      const allowed = yield* together(Session.ID.make("ses_geocode_tools_together"))
      expect(allowed.map((execution) => execution.status)).toEqual(["completed", "completed"])
      // Guards against asking once for each of two calls made at once.
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])

      reset()
      refused = "read"
      const session = Session.ID.make("ses_geocode_tools_together_refused")
      const refusedBoth = yield* together(session)
      expect(refusedBoth.map((execution) => execution.status)).toEqual(["error", "error"])
      expect(calls).toEqual([])
      reset()
      yield* executeTool(registry, read({ path: outside }, session))
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
    }),
  )

  it.effect("asks again about a dataset whose asking was interrupted", () =>
    Effect.gen(function* () {
      reset()
      answer = () => result({ text: "dem.tif: raster, GeoTIFF" })
      const registry = yield* Tool.Service
      const session = Session.ID.make("ses_geocode_tools_interrupted")
      const outside = path.join(path.parse(PROJECT).root, "survey", "dem.tif")
      pending = yield* Deferred.make<void>()
      const asking = yield* Effect.forkChild(executeTool(registry, read({ path: outside }, session)))
      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
      yield* Fiber.interrupt(asking)
      pending = undefined
      // Guards against keeping an asking the user never answered, which would hold every later call on it.
      const again = yield* executeTool(registry, read({ path: outside }, session))
      expect(again.status).toBe("completed")
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "external_directory", "read"])
    }),
  )

  it.effect("hands a preview to the model as an image beside its description", () =>
    Effect.gen(function* () {
      reset()
      // One pixel: the kernel decodes every image a tool returns, and drops one it cannot.
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      answer = () => result({ text: "dem.tif: raster preview, GeoTIFF", image: png })
      const preview = yield* executeTool(yield* Tool.Service, read({ path: "dem.tif", preview: true, bands: [1] }))
      expect(preview).toMatchObject({
        status: "completed",
        content: [
          { type: "text", text: "dem.tif: raster preview, GeoTIFF" },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "dem.tif" },
        ],
      })
    }),
  )

  // Guards against GeoAgent reading GeoCode's internals, while keeping what GDAL said about the data.
  it.effect("tells GeoAgent what went wrong with the data, and only what to do about the rest", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const failing = (code: string, message: string) => {
        answer = () => [
          JSON.stringify({ type: "result", ok: false, error: { code, message, details: { stderr: "Traceback" } } }),
        ]
        return executeTool(registry, read({ path: "dem.tif" }))
      }
      expect((yield* failing("read-failed", "TIFFReadDirectory: Not a TIFF file")).error?.message).toBe(
        "GDAL failed while reading dem.tif: TIFFReadDirectory: Not a TIFF file",
      )
      expect((yield* failing("timeout", "reading reported nothing for 5 minutes")).error?.message).toBe(
        "Reading dem.tif stopped without an answer. Tell the user.",
      )
      expect((yield* failing("crashed", "exited with signal SIGSEGV")).error?.message).toBe(
        "Reading dem.tif stopped without an answer. Tell the user.",
      )
      expect((yield* failing("not-ready", "QGIS is not configured. Ask the user.")).error?.message).toBe(
        "QGIS is not configured. Ask the user.",
      )
      expect((yield* failing("start-failed", "spawn ENOENT")).error?.message).toBe(
        "The QGIS tools are not available right now. Tell the user; restarting GeoCode may fix it.",
      )
    }),
  )
})
