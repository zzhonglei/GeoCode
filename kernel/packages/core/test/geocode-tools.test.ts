import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { GeeRunTool } from "@opencode/core/geocode/geerun"
import { GeoTools } from "@opencode/core/geocode/tools"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const TOKEN = "kernel-callback-token"
const sessionID = Session.ID.make("ses_geocode_tools_test")

const assertions: Permission.AssertInput[] = []
const calls: Array<{ readonly authorization: string | null; readonly body: unknown }> = []
/** The shell server's answer: its lines at once, or a stream that is written as the test goes. */
let answer = (_body: { method: string; params: Record<string, unknown> }): string[] | ReadableStream => [
  JSON.stringify({ type: "result", ok: true, result: { text: "QGIS 4.2.3\n\nBuffer (native:buffer)" } }),
]
/** Calls whose request the kernel broke off, as it does to end a task. */
const aborted: string[] = []

let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  // Stands in for the shell server's geo tool route.
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // As the shell server, which leaves a silent run's stream open.
    idleTimeout: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/api/geocode/geo-tool") return new Response("not found", { status: 404 })
      const body = (await request.json()) as { method: string; params: Record<string, unknown> }
      calls.push({ authorization: request.headers.get("authorization"), body })
      request.signal.addEventListener("abort", () => aborted.push(body.method))
      const lines = answer(body)
      return new Response(Array.isArray(lines) ? lines.join("\n") + "\n" : lines, {
        headers: { "content-type": "application/x-ndjson" },
      })
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

/** The evaluate hook the plugin registers, for the tests to call as the permission rules would. */
let evaluate: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
/** What "always allow" saved for the project. */
let saved: Array<{ action: string; resource: string }> = []

/** The geo tools' plugin storage, which the kernel keeps in its database. */
const stored = new Map<string, Schema.Json>()

const geoToolsNode = makeLocationNode({
  name: "test/geocode-tools-plugin",
  layer: Layer.effectDiscard(
    registerToolPlugin(GeoTools.Plugin, {
      permission: {
        hook: (_name, callback) =>
          Effect.sync(() => {
            evaluate = callback as typeof evaluate
            return { dispose: Effect.void }
          }),
        list: () => Effect.die("unused permission.list"),
        get: () => Effect.die("unused permission.get"),
        reply: () => Effect.die("unused permission.reply"),
      },
      storage: {
        get: (key) => Effect.sync(() => stored.get(key)),
        set: (key, value) => Effect.sync(() => void stored.set(key, value)),
        remove: (key) => Effect.sync(() => void stored.delete(key)),
        scan: () => Effect.die("unused storage.scan"),
      },
    }),
  ),
  deps: [Tool.node, Permission.node, FileAccess.node, Location.node, PermissionSaved.node, Job.node, Session.node],
})
/** What the kernel's key-value store holds: a background run's notification, until it is in the conversation. */
const kv = new Map<string, KV.Value>()
const kvStore = Layer.succeed(
  KV.Service,
  KV.Service.of({
    get: (key) => Effect.sync(() => kv.get(key)),
    set: (key, value) => Effect.sync(() => void kv.set(key, value)),
    remove: (key) => Effect.sync(() => void kv.delete(key)),
    scan: ({ prefix }) =>
      Effect.sync(() => ({
        entries: [...kv].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      })),
  }),
)
/** The notifications put into conversations. */
const notices: Array<Parameters<Session.Interface["synthetic"]>[0]> = []
let noticed: Deferred.Deferred<void> | undefined
const sessions = Layer.mock(Session.Service, {
  // Unused, but not optional as the service's functions are.
  revert: {} as Session.Interface["revert"],
  synthetic: (input) =>
    Effect.sync(() => notices.push(input)).pipe(
      Effect.andThen(noticed ? Deferred.succeed(noticed, undefined) : Effect.void),
      Effect.as({} as never),
    ),
})
const permissionSaved = Layer.mock(PermissionSaved.Service, {
  list: () => Effect.sync(() => saved.map((item) => ({ ...item }) as unknown as PermissionSaved.Info)),
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
  AppNodeBuilder.build(LayerNode.group([Tool.node, geoToolsNode, Job.node, Session.node]), [
    Permission.node.replace(permission),
    PermissionSaved.node.replace(permissionSaved),
    KV.node.replace(kvStore),
    Session.node.replace(sessions),
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory: PROJECT })))),
  ]),
)

const reset = () => {
  assertions.length = 0
  calls.length = 0
  aborted.length = 0
  refused = undefined
  pending = undefined
  saved = []
  stored.clear()
  kv.clear()
  notices.length = 0
  noticed = undefined
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
          error: { code: "not-ready", message: "QGIS is not configured.\nIts configuration is in machine.json." },
        }),
      ]
      const result = yield* executeTool(yield* Tool.Service, call({ action: "groups", algorithm: "native:buffer" }))
      expect(result.status).toBe("error")
      expect(JSON.stringify(result.error)).toContain("QGIS is not configured.\\nIts configuration is in machine.json.")
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
      expect(listing.error?.message).toBe("QGIS could not list its algorithms.")
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
        "Reading dem.tif stopped without an answer.",
      )
      expect((yield* failing("crashed", "exited with signal SIGSEGV")).error?.message).toBe(
        "Reading dem.tif stopped without an answer.",
      )
      expect((yield* failing("not-ready", "QGIS is not configured.")).error?.message).toBe("QGIS is not configured.")
      expect((yield* failing("start-failed", "spawn ENOENT")).error?.message).toBe(
        "The QGIS tools are not available right now. Tell the user; restarting GeoCode may fix it.",
      )
    }),
  )
})

const runs = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-qgisrun", name: "qgisrun", input },
})

const HEADER = "QGIS 4.2.3\nnative:buffer — Buffer: Computes a buffer area.\nDefaults used: SEGMENTS=5"

const plan = (fields: Record<string, unknown> = {}) => ({
  header: HEADER,
  notes: ["Defaults used: SEGMENTS=5"],
  parameters: { INPUT: path.join(PROJECT, "roads.shp"), DISTANCE: 100, OUTPUT: path.join(PROJECT, "out_1.gpkg") },
  algorithm: {
    id: "native:buffer",
    name: "Buffer",
    description: "Computes a buffer area.",
    translations: { "zh-CN": { name: "缓冲区", description: "计算缓冲区。" } },
  },
  inputs: [{ name: "INPUT", value: path.join(PROJECT, "roads.shp") }],
  outputs: [
    {
      name: "OUTPUT",
      value: path.join(PROJECT, "out_1.gpkg"),
      files: [path.join(PROJECT, "out_1.gpkg")],
      folder: false,
    },
  ],
  options: [{ name: "DISTANCE", value: 100 }],
  ...fields,
})

/** GeoEngine's three steps; `run` gives the lines of the last. */
const engine = (steps: {
  locate?: unknown
  prepare?: unknown
  run?: (params: Record<string, unknown>) => string[] | ReadableStream
}) => {
  answer = (body) => {
    if (body.method === "qgis.locate") return result(steps.locate ?? { files: ["roads.shp", "out.gpkg"] })
    if (body.method === "qgis.prepare") return result(steps.prepare ?? { plan: plan() })
    return steps.run?.(body.params) ?? result({ ending: "Finished in 1 s." })
  }
}

const progress = (data: unknown) => JSON.stringify({ type: "progress", data })

/** As the kernel's events hold a tool's metadata. */
const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

describe("GeoCode: qgisrun", () => {
  it.effect("checks the run, asks once about it, runs it, and answers with every line in order", () =>
    Effect.gen(function* () {
      reset()
      engine({
        run: () => [
          progress({ percent: 50 }),
          progress({ level: "info", text: "half way" }),
          progress({ level: "warning", text: "1 feature skipped" }),
          ...result({ ending: `Finished in 1 s.\nOutputs:\n- OUTPUT: ${path.join(PROJECT, "out_1.gpkg")}` }),
        ],
      })
      const registry = yield* Tool.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("qgisrun")
      const parameters = { INPUT: "roads.shp", DISTANCE: 100, OUTPUT: "out.gpkg" }
      const ran = yield* executeTool(
        registry,
        runs({ algorithm: "native:buffer", parameters, description: "缓冲道路" }),
      )
      expect(ran).toMatchObject({
        status: "completed",
        content: [
          {
            type: "text",
            text:
              `${HEADER}\n\nhalf way\n1 feature skipped\n\n` +
              `Finished in 1 s.\nOutputs:\n- OUTPUT: ${path.join(PROJECT, "out_1.gpkg")}`,
          },
        ],
      })
      // Guards against resolving paths otherwise than read and write do, and running other parameters than checked.
      expect(calls.map((call) => call.body)).toEqual([
        { method: "qgis.locate", params: { algorithm: "native:buffer", parameters } },
        {
          method: "qgis.prepare",
          params: {
            algorithm: "native:buffer",
            parameters,
            files: [path.join(PROJECT, "roads.shp"), path.join(PROJECT, "out.gpkg")],
            cwd: PROJECT,
          },
        },
        { method: "qgis.run", params: { algorithm: "native:buffer", parameters: plan().parameters, cwd: PROJECT } },
      ])
      expect(assertions).toMatchObject([
        {
          action: "qgisrun",
          resources: ["native:buffer"],
          save: ["*"],
          metadata: {
            description: "缓冲道路",
            algorithm: { id: "native:buffer", translations: { "zh-CN": { name: "缓冲区" } } },
            outputs: [{ name: "OUTPUT", external: false }],
            options: [{ name: "DISTANCE", value: 100 }],
            external: [],
            guarded: false,
            guards: [],
          },
        },
      ])
    }),
  )

  it.effect("asks about a listed algorithm and every directory outside the project in one asking", () =>
    Effect.gen(function* () {
      reset()
      const elsewhere = path.join(path.parse(PROJECT).root, "exports")
      engine({
        prepare: {
          plan: plan({
            algorithm: { id: "native:truncatetable", name: "Truncate table", description: "", translations: {} },
            outputs: [
              { name: "OUTPUT", value: "x", files: [path.join(elsewhere, "a.gpkg")], folder: false },
              { name: "REPORT", value: "y", files: [path.join(elsewhere, "b.html")], folder: false },
              { name: "INSIDE", value: "z", files: [path.join(PROJECT, "c.gpkg")], folder: false },
            ],
          }),
        },
      })
      yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:truncatetable", parameters: {} }))
      // Guards against a second card: the directory is not asked about apart, as other tools ask.
      expect(assertions).toHaveLength(1)
      expect(assertions[0]).toMatchObject({
        action: "qgisrun",
        resources: ["native:truncatetable", path.join(elsewhere, "*")],
        metadata: {
          guarded: true,
          external: [elsewhere],
          outputs: [{ external: true }, { external: true }, { external: false }],
        },
      })
    }),
  )

  it.effect("asks about every database a run writes to, once each, as it asks about a listed algorithm", () =>
    Effect.gen(function* () {
      reset()
      const roads = `postgis:dbname='gis' host=db table="public"."roads" (geom)`
      const lakes = `postgis:dbname='gis' host=db table="public"."lakes" (geom)`
      const database = "postgres: host=db dbname=gis"
      engine({
        prepare: {
          plan: plan({
            outputs: [
              { name: "OUTPUT", value: roads, files: [], folder: false, place: database },
              { name: "OTHER", value: lakes, files: [], folder: false, place: database },
              { name: "INSIDE", value: "z", files: [path.join(PROJECT, "c.gpkg")], folder: false },
            ],
          }),
        },
      })
      yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} }))
      expect(assertions).toHaveLength(1)
      // Guards against "always allow" for this database reaching the whole tool, or another database, and against the
      // rules written for the algorithm not holding where it writes.
      expect(assertions[0]).toMatchObject({
        resources: ["native:buffer", database],
        save: [database],
        metadata: { guarded: false, external: [], elsewhere: [roads, lakes], guards: [database] },
      })
    }),
  )

  it.effect("asks about a guarded run where the rules allow the tool, unless each guard was always allowed", () =>
    Effect.gen(function* () {
      reset()
      expect(evaluate).toBeDefined()
      const verdict = (event: Partial<PermissionEvaluation>) =>
        Effect.gen(function* () {
          const full = { sessionID, action: "qgisrun", resources: [], effect: "allow" as const, ...event }
          yield* evaluate!(full)
          return full.effect
        })
      const guards = { guards: ["native:truncatetable", "/exports/*"] }
      expect(yield* verdict({ metadata: { guards: [] } })).toBe("allow")
      expect(yield* verdict({ metadata: guards })).toBe("ask")
      // Guards against "always allow" for the tool as a whole reaching what the list and outside writes guard.
      saved = [
        { action: "qgisrun", resource: "*" },
        { action: "qgisrun", resource: "native:truncatetable" },
      ]
      expect(yield* verdict({ metadata: guards })).toBe("ask")
      saved.push({ action: "qgisrun", resource: "/*" })
      expect(yield* verdict({ metadata: guards })).toBe("allow")
      // Leaves a refusal, an asking and other tools as the rules made them.
      saved = []
      expect(yield* verdict({ metadata: guards, effect: "deny" })).toBe("deny")
      expect(yield* verdict({ metadata: guards, action: "read" })).toBe("allow")
    }),
  )

  it.effect("refuses before asking a run that cannot work, and says why", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      engine({ locate: { refused: "QGIS 4.2.3\n\nnative:openurl is not available." } })
      const excluded = yield* executeTool(registry, runs({ algorithm: "native:openurl", parameters: {} }))
      expect(excluded).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "QGIS 4.2.3\n\nnative:openurl is not available." }],
      })
      engine({ prepare: { refused: `${HEADER}\n\nmixed.geojson mixes points and lines in one layer` } })
      const mixed = yield* executeTool(registry, runs({ algorithm: "native:buffer", parameters: {} }))
      expect(mixed.status).toBe("completed")
      // Guards against a call without a label never completing: the kernel stores metadata as JSON, refusing undefined.
      expect(isJsonRecord(excluded.metadata) && isJsonRecord(mixed.metadata)).toBe(true)
      expect(assertions).toEqual([])
      expect(calls.map((call) => (call.body as { method: string }).method)).toEqual([
        "qgis.locate",
        "qgis.locate",
        "qgis.prepare",
      ])
    }),
  )

  // Guards against telling GeoAgent the tools are down when only the data could not be checked.
  it.effect("says the data could not be checked when the survey before asking stops without an answer", () =>
    Effect.gen(function* () {
      reset()
      answer = (body) =>
        body.method === "qgis.locate"
          ? result({ files: ["data/broken.geojson"] })
          : [JSON.stringify({ type: "result", ok: false, error: { code: "crashed", message: "signal SIGSEGV" } })]
      const crashed = yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} }))
      expect(crashed.error?.message).toBe(
        "Checking the data the parameters name stopped without an answer, so nothing was run.",
      )
      expect(assertions).toEqual([])
    }),
  )

  it.effect("keeps everything QGIS said when a run fails or crashes, and ends the answer with how", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const failing = (code: string, ending: string) => {
        engine({
          run: () => [
            progress({ level: "error", text: "Incorrect parameter value for DISTANCE" }),
            JSON.stringify({ type: "result", ok: false, error: { code, message: "boom", details: { ending } } }),
          ],
        })
        return executeTool(registry, runs({ algorithm: "native:buffer", parameters: {} }))
      }
      const failed = yield* failing(
        "algorithm-failed",
        "Failed after 0.4 s.\nDISTANCE: Distance (distance, default 10)",
      )
      expect(failed).toMatchObject({
        status: "completed",
        content: [
          {
            text: `${HEADER}\n\nIncorrect parameter value for DISTANCE\n\nFailed after 0.4 s.\nDISTANCE: Distance (distance, default 10)`,
          },
        ],
      })
      const crashed = yield* failing("crashed", "QGIS exited unexpectedly after 5 s.")
      expect(crashed.status).toBe("completed")
      expect(isJsonRecord(failed.metadata) && isJsonRecord(crashed.metadata)).toBe(true)
      // Guards against GeoAgent reading GeoCode's internals when the chain itself fails.
      const broken = yield* failing("start-failed", "")
      expect(broken.error?.message).toBe(
        "The QGIS tools are not available right now. Tell the user; restarting GeoCode may fix it.",
      )
    }),
  )

  it.live(
    "stops a run that reports nothing for its timeout, keeping what it said",
    () =>
      Effect.gen(function* () {
        reset()
        const half = path.join(PROJECT, "half.gpkg")
        engine({
          prepare: { plan: plan({ outputs: [{ name: "OUTPUT", value: half, files: [half], folder: false }] }) },
          run: () =>
            new ReadableStream({
              start: (controller) =>
                controller.enqueue(
                  new TextEncoder().encode(
                    `${progress({ begun: true })}\n${progress({ level: "info", text: "started" })}\n`,
                  ),
                ),
            }),
        })
        const started = Date.now()
        const stopped = yield* executeTool(
          yield* Tool.Service,
          runs({ algorithm: "native:buffer", parameters: {}, timeout: 1 }),
        )
        // The least timeout holds however short GeoAgent asks for.
        expect(Date.now() - started).toBeGreaterThanOrEqual(10000)
        expect(stopped).toMatchObject({
          status: "completed",
          content: [
            {
              text: expect.stringMatching(
                new RegExp(`^${HEADER}\\n\\nstarted\\n\\nStopped after 1\\d s, with no progress for the last 10 s\\.$`),
              ),
            },
          ],
        })
        // Guards against leaving the task running in GeoEngine after giving up on it.
        for (let turn = 0; turn < 100 && !aborted.includes("qgis.run"); turn++) yield* Effect.sleep("10 millis")
        expect(aborted).toContain("qgis.run")
      }),
    20000,
  )

  // Guards against stopping a run for the silence of QGIS starting, which reports nothing until the algorithm begins.
  it.live(
    "counts the silence from when the algorithm begins, not while QGIS starts",
    () =>
      Effect.gen(function* () {
        reset()
        const encoder = new TextEncoder()
        engine({
          run: () =>
            new ReadableStream({
              start: (controller) => {
                setTimeout(() => {
                  controller.enqueue(encoder.encode(`${progress({ begun: true })}\n`))
                  controller.enqueue(encoder.encode(`${result({ ending: "Finished in 12 s." }).join("\n")}\n`))
                  controller.close()
                }, 11500)
              },
            }),
        })
        const ran = yield* executeTool(
          yield* Tool.Service,
          runs({ algorithm: "native:buffer", parameters: {}, timeout: 10 }),
        )
        expect(ran).toMatchObject({ status: "completed", metadata: { outcome: "finished" } })
      }),
    20000,
  )

  it.effect("gives the interface the latest messages only, and GeoAgent every one", () =>
    Effect.gen(function* () {
      reset()
      const lines = Array.from({ length: 600 }, (_, index) => progress({ level: "info", text: `line ${index}` }))
      engine({ run: () => [...lines, ...result({ ending: "Finished in 1 s." })] })
      const ran = yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} }))
      const shown = (ran.metadata as { messages: { text: string }[] }).messages
      expect([shown.length, shown[0]?.text, shown.at(-1)?.text]).toEqual([500, "line 100", "line 599"])
      expect(ran.content).toMatchObject([{ text: expect.stringContaining("\nline 0\n") }])
    }),
  )

  // Guards against the row counting the wait for the user's answer as the run's time.
  it.live("tells the interface when the run began, after the user answered", () =>
    Effect.gen(function* () {
      reset()
      engine({})
      pending = yield* Deferred.make<void>()
      const asking = yield* Effect.forkChild(
        executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} })),
      )
      for (let turn = 0; turn < 100 && !assertions.length; turn++) yield* Effect.sleep("10 millis")
      yield* Effect.sleep("50 millis")
      const answered = Date.now()
      yield* Deferred.succeed(pending, undefined)
      const ran = yield* Fiber.join(asking)
      expect(ran.metadata?.started).toBeGreaterThanOrEqual(answered)
    }),
  )
})

const TASK = "taipei-ndvi-20261008"

/** A call of GeoAgent's, continuing TASK with a label unless the input says otherwise; `bare` leaves both out. */
const gee = (input: Record<string, unknown>, bare = false) => ({
  sessionID,
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id: "call-geerun",
    name: "geerun",
    input: bare ? input : { description: "统计影像", task: TASK, ...input },
  },
})

/** A finished run of GeoEngine's, with what the script printed. */
const ran = (fields: Record<string, unknown> = {}) =>
  result({
    outcome: "finished",
    output: "images: 73\n",
    truncated: false,
    durationMs: 1200,
    ...fields,
  })

/** What GeoEngine read of TASK and GeoCode's folder before the script ran. */
const space = (fields: Record<string, unknown> = {}) => ({
  assets: [],
  more: 0,
  others: [],
  tasks: 0,
  ...fields,
})

describe("GeoCode: geerun", () => {
  it.effect("asks as the shell is asked, runs the script in the project, and answers with what it printed", () =>
    Effect.gen(function* () {
      reset()
      answer = () => ran()
      const registry = yield* Tool.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "geerun")
      expect(definition).toBeDefined()
      const done = yield* executeTool(registry, gee({ script: "print(1)" }))
      expect(done).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "images: 73\n\nFinished in 1 s." }],
        metadata: { description: "统计影像", task: TASK, outcome: "finished" },
      })
      expect(assertions).toMatchObject([
        {
          action: "geerun",
          resources: ["*"],
          save: ["*"],
          metadata: { description: "统计影像", task: TASK, script: "print(1)" },
        },
      ])
      // Guards against the run reaching GeoEngine without the kernel's token, or outside the project's directory.
      const task = { name: TASK, new: false, started: false }
      expect(calls).toEqual([
        { authorization: `Bearer ${TOKEN}`, body: { method: "gee.check", params: { cwd: PROJECT } } },
        {
          authorization: `Bearer ${TOKEN}`,
          body: { method: "gee.run", params: { cwd: PROJECT, task, script: "print(1)" } },
        },
      ])

      reset()
      yield* executeTool(
        registry,
        gee({ description: "新任务", new_task: "hualien-flood-20261008", path: "scripts/a.py" }, true),
      )
      expect(calls.at(-1)?.body).toEqual({
        method: "gee.run",
        params: {
          cwd: PROJECT,
          task: { name: "hualien-flood-20261008", new: true, started: false },
          file: path.join(PROJECT, "scripts/a.py"),
        },
      })
    }),
  )

  // Guards against a task that saved nothing being lost to the conversation that started it, and against a mistyped
  // name being taken for a new task.
  it.effect("remembers the tasks a conversation starts, for that conversation alone", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const start = gee({ description: "新任务", new_task: "hualien-flood-20261008", script: "x" }, true)
      // Guards against keeping a name the run refused, or never got to check: a Python that ended before the header.
      answer = () => [JSON.stringify({ type: "result", ok: false, error: { code: "task-taken", message: "taken" } })]
      expect((yield* executeTool(registry, start)).status).toBe("error")
      answer = () => ran({ outcome: "crashed", output: "Segmentation fault\n" })
      expect((yield* executeTool(registry, start)).status).toBe("completed")
      expect(stored.size).toBe(0)

      // Kept once the run got past the checks, though its script failed.
      answer = () => ran({ outcome: "failed", space: space() })
      expect((yield* executeTool(registry, start)).status).toBe("completed")
      expect(stored.get(`geerun/tasks/${sessionID}`)).toEqual(["hualien-flood-20261008"])
      calls.length = 0
      expect((yield* executeTool(registry, start)).error?.message).toBe(
        'The task hualien-flood-20261008 was already started in this conversation. Continue it with "task", or give "new_task" another ID.',
      )
      expect(calls).toEqual([])

      yield* executeTool(registry, gee({ task: "hualien-flood-20261008", script: "x" }))
      expect(calls.at(-1)?.body).toMatchObject({
        params: { task: { name: "hualien-flood-20261008", new: false, started: true } },
      })
      // Guards against one conversation's tasks without a folder being continued from another.
      yield* executeTool(registry, {
        ...gee({ task: "hualien-flood-20261008", script: "x" }),
        sessionID: Session.ID.make("ses_geocode_tools_other"),
      })
      expect(calls.at(-1)?.body).toMatchObject({
        params: { task: { name: "hualien-flood-20261008", new: false, started: false } },
      })
    }),
  )

  // Guards against asking the user about a run that cannot start, as while Earth Engine is not set up.
  it.effect("asks nothing and runs nothing when the check finds Earth Engine not ready", () =>
    Effect.gen(function* () {
      reset()
      answer = (body) =>
        body.method === "gee.check"
          ? [JSON.stringify({ type: "result", ok: false, error: { code: "not-ready", message: "Not signed in." } })]
          : ran()
      const done = yield* executeTool(yield* Tool.Service, gee({ path: "scripts/ndvi.py" }))
      expect(done.error?.message).toBe("Not signed in.")
      expect(assertions).toEqual([])
      expect(calls.map((call) => call.body)).toEqual([
        { method: "gee.check", params: { cwd: PROJECT, file: path.join(PROJECT, "scripts/ndvi.py") } },
      ])
    }),
  )

  it.effect("runs a file at its absolute path, asking first about its directory when it is outside the project", () =>
    Effect.gen(function* () {
      reset()
      answer = () => ran()
      const registry = yield* Tool.Service
      yield* executeTool(registry, gee({ path: "scripts/ndvi.py" }))
      expect(assertions.map((input) => input.action)).toEqual(["geerun"])
      expect(assertions[0]?.metadata).toEqual({
        description: "统计影像",
        task: TASK,
        path: path.join(PROJECT, "scripts/ndvi.py"),
      })
      const task = { name: TASK, new: false, started: false }
      expect(calls.map((call) => call.body)).toEqual([
        { method: "gee.check", params: { cwd: PROJECT, file: path.join(PROJECT, "scripts/ndvi.py") } },
        { method: "gee.run", params: { cwd: PROJECT, task, file: path.join(PROJECT, "scripts/ndvi.py") } },
      ])

      reset()
      const outside = path.join(path.parse(PROJECT).root, "elsewhere", "ndvi.py")
      yield* executeTool(registry, gee({ path: outside }))
      // Guards against running a file outside the project without asking about its directory, as the shell asks.
      expect(assertions.map((input) => [input.action, input.resources])).toEqual([
        ["external_directory", [path.join(path.dirname(outside), "*")]],
        ["geerun", ["*"]],
      ])
      // Guards against GeoEngine looking at a file outside the project before the user allows its directory.
      expect(calls.map((call) => call.body)).toEqual([
        { method: "gee.check", params: { cwd: PROJECT } },
        { method: "gee.run", params: { cwd: PROJECT, task, file: outside } },
      ])

      reset()
      answer = (body) =>
        body.method === "gee.check"
          ? [JSON.stringify({ type: "result", ok: false, error: { code: "not-ready", message: "Not signed in." } })]
          : ran()
      expect((yield* executeTool(registry, gee({ path: outside }))).error?.message).toBe("Not signed in.")
      expect(assertions).toEqual([])
    }),
  )

  it.effect(
    "runs nothing without a label, one task, one script and a task name that fits, or when the user refuses",
    () =>
      Effect.gen(function* () {
        reset()
        const registry = yield* Tool.Service
        for (const input of [{}, { script: "print(1)", path: "a.py" }]) {
          const refusal = yield* executeTool(registry, gee(input))
          expect(refusal.error?.message).toBe('Give exactly one of "script" and "path".')
        }
        const task = 'Give exactly one of "task", to continue a task, and "new_task", to start one.'
        const cases: [Record<string, unknown>, string][] = [
          [{ description: "x", script: "print(1)" }, task],
          [{ description: "x", script: "print(1)", task: TASK, new_task: "b" }, task],
          ...["taipei ndvi", "台北-ndvi", "", "a".repeat(31)].map((name): [Record<string, unknown>, string] => [
            { description: "x", script: "print(1)", new_task: name },
            `"${name}" is not a task name: use 1 to 30 letters, digits, "_" or "-", such as taipei-ndvi-20261008.`,
          ]),
        ]
        for (const [input, message] of cases) {
          expect((yield* executeTool(registry, gee(input, true))).error?.message).toBe(message)
        }
        expect((yield* executeTool(registry, gee({ script: "print(1)", task: TASK }, true))).status).toBe("error")
        expect(calls).toEqual([])
        refused = "geerun"
        expect((yield* executeTool(registry, gee({ script: "print(1)" }))).status).toBe("error")
        expect(calls.map((call) => call.body)).toMatchObject([{ method: "gee.check" }])
      }),
  )

  it.effect("ends the answer with how the run ended", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const cases: [Record<string, unknown>, string][] = [
        [
          { outcome: "failed", output: "Traceback (most recent call last):\nZeroDivisionError\n" },
          "Traceback (most recent call last):\nZeroDivisionError\n\nThe script failed after 1 s.",
        ],
        [
          { outcome: "idle", output: "", durationMs: 125000, idleSeconds: 120 },
          "(The script printed nothing.)\n\nStopped after 125 s: for the last 120 s the script printed nothing and waited for no request to Earth Engine.",
        ],
        [
          { outcome: "crashed", output: "Segmentation fault\n", exit: "signal SIGSEGV", durationMs: 300 },
          "Segmentation fault\n\nThe Python ended with signal SIGSEGV after 0.3 s, before the script finished.",
        ],
        [
          { output: "line 9999\n", truncated: true },
          "(The output was too long; only its end is kept.)\n\nline 9999\n\nFinished in 1 s.",
        ],
      ]
      for (const [fields, text] of cases) {
        answer = () => ran(fields)
        const done = yield* executeTool(registry, gee({ script: "x" }))
        expect(done).toMatchObject({ status: "completed", content: [{ type: "text", text }] })
      }
    }),
  )

  it.effect("starts the answer with the task, its assets, and the latest other tasks", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      // GeoAgent works by the names of tasks and assets, never by where Earth Engine keeps them.
      const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
        [{ task: TASK }, space(), `Task ${TASK}: nothing saved yet.`],
        [
          { new_task: TASK },
          space({
            others: [{ name: "a-20261001", assets: 2, updated: "2026-10-01T08:30:12.5Z" }],
            tasks: 1,
          }),
          `Task ${TASK} (new): nothing saved yet.\nOther tasks in GeoCode:\n- a-20261001 (2 assets, updated 2026-10-01 08:30 UTC)`,
        ],
        [
          { task: TASK },
          space({
            assets: [
              {
                name: "composite",
                type: "IMAGE",
                saved: "2026-10-08T05:59:00Z",
                bands: ["B4", "B8"],
                title: "台北夏季合成",
                description: "Sentinel-2 中值合成",
              },
              { name: "area", type: "TABLE", saved: "2026-10-08T02:00:00Z" },
            ],
            more: 3,
            others: [
              { name: "b-20260902", assets: 1, updated: "2026-10-01T00:00:00Z" },
              { name: "d-20260904", assets: 0, updated: "2026-09-04T00:00:00Z" },
              { name: "c-20260903", assets: 0, updated: "2026-09-03T00:00:00Z" },
            ],
            tasks: 4,
          }),
          [
            `Task ${TASK}: 5 assets.`,
            "- composite (image; bands B4, B8; saved 2026-10-08 05:59 UTC): 台北夏季合成. Sentinel-2 中值合成",
            "- area (table; saved 2026-10-08 02:00 UTC)",
            "- and 3 more assets",
            "Other tasks in GeoCode (4 in all, the latest 3):",
            "- b-20260902 (1 asset, updated 2026-10-01 00:00 UTC)",
            "- d-20260904 (0 assets, updated 2026-09-04 00:00 UTC)",
            "- c-20260903 (0 assets, updated 2026-09-03 00:00 UTC)",
          ].join("\n"),
        ],
      ]
      for (const [input, read, header] of cases) {
        answer = () => ran({ space: read })
        const done = yield* executeTool(registry, gee({ description: "x", script: "x", ...input }, true))
        expect(done).toMatchObject({
          status: "completed",
          content: [{ type: "text", text: `${header}\n\nimages: 73\n\nFinished in 1 s.` }],
        })
      }
    }),
  )

  // Guards against a header the kernel cannot read hiding a script that ran, and may have started exports.
  it.effect("answers without the header when it cannot be read", () =>
    Effect.gen(function* () {
      reset()
      answer = () => ran({ space: { assets: "none" } })
      const done = yield* executeTool(yield* Tool.Service, gee({ script: "x" }))
      expect(done).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "images: 73\n\nFinished in 1 s." }],
      })
    }),
  )

  // Guards against the kernel's own cut, which keeps the start, losing a long run's traceback and how it ended.
  it.effect("keeps the end of a long output, within the kernel's bounds, and marks the answer as cut", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const lines = Array.from({ length: 3000 }, (_, index) => `image ${index}`)
      const huge = "x".repeat(ToolOutput.MAX_BYTES * 2)
      // More than the header's share holds: a hundred assets with long titles, descriptions and band lists.
      const bands = Array.from({ length: 50 }, (_, index) => `band_${index}`)
      const asset = { name: "a".repeat(30), type: "IMAGE", saved: "2026-10-08T00:00:00Z", bands }
      const full = space({
        assets: Array.from({ length: 100 }, () => ({
          ...asset,
          title: "标".repeat(100),
          description: "说\n".repeat(500),
        })),
        others: [{ name: "b-20260902", assets: 1, updated: "2026-10-01T00:00:00Z" }],
        tasks: 1,
      })
      const outputs = [[...lines, "ZeroDivisionError"].join("\n"), `${huge}ZeroDivisionError`]
      for (const [output, read] of outputs.flatMap((output) =>
        [full, undefined].map((read) => [output, read] as const),
      )) {
        answer = () => ran({ outcome: "failed", output, ...(read ? { space: read } : {}) })
        const done = yield* executeTool(registry, gee({ script: "x" }))
        const first = done.content?.[0]
        const text = first?.type === "text" ? first.text : ""
        const opening = read ? text.slice(text.indexOf("\n\n(The output") + 2) : text
        expect(opening.startsWith("(The output was too long; only its end is kept.)\n\n")).toBe(true)
        // The header gives way first, to its share, by its last assets: the other tasks stay, and the descriptions
        // stay on their own lines.
        if (read) {
          const listing = text.slice(0, text.indexOf("\n\n(The output"))
          const shown = listing.split("\n").filter((line) => line.startsWith(`- ${"a".repeat(30)}`)).length
          expect(shown).toBeGreaterThan(0)
          expect(listing).toContain(
            `\n- and ${100 - shown} more assets\nOther tasks in GeoCode:\n- b-20260902 (1 asset, updated 2026-10-01 00:00 UTC)`,
          )
          expect(listing.endsWith("UTC)")).toBe(true)
          expect(Buffer.byteLength(listing, "utf-8")).toBeLessThanOrEqual(ToolOutput.MAX_BYTES / 2)
          expect(listing.split("\n").length).toBe(shown + 4)
        }
        expect(text.endsWith("ZeroDivisionError\n\nThe script failed after 1 s.")).toBe(true)
        expect(text.split("\n").length).toBeLessThanOrEqual(ToolOutput.MAX_LINES)
        expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
        expect(done.metadata).toMatchObject({ truncated: true })
      }
    }),
  )

  it.effect("tells GeoAgent what to do when Earth Engine is not ready, and only that when GeoCode cannot answer", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const cases: [Record<string, unknown>, string][] = [
        [
          { code: "not-ready", message: "Google Earth Engine is not configured.\nThe configuration is the gee block." },
          "Google Earth Engine is not configured.\nThe configuration is the gee block.",
        ],
        [
          { code: "invalid-params", message: "/project/none.py is not a file" },
          "/project/none.py is not a file, so the script did not run.",
        ],
        [
          { code: "initialize-failed", message: "EEException: Not signed up for Earth Engine" },
          "Earth Engine could not be initialized, so the script did not run: EEException: Not signed up for Earth Engine",
        ],
        [
          { code: "space-failed", message: "EEException: Caller does not have required permission" },
          "GeoCode could not read its folder of Earth Engine assets, so the script did not run: EEException: Caller does not have required permission",
        ],
        [
          { code: "task-taken", message: `The task ${TASK} already exists, with 1 asset: composite` },
          `The task ${TASK} already exists, with 1 asset: composite, so the script did not run. Continue it with "task", or give "new_task" another ID.`,
        ],
        [
          { code: "task-missing", message: `There is no task ${TASK}: it has saved nothing` },
          `There is no task ${TASK}: it has saved nothing, so the script did not run. Start it with "new_task", or check the ID.`,
        ],
        [
          { code: "task-busy", message: `The task ${TASK} is already running in another call` },
          `The task ${TASK} is already running in another call, perhaps in another conversation, so the script did not run. Run it again after that call ends.`,
        ],
        [
          { code: "start-failed", message: "spawn EACCES", details: { stderr: "x" } },
          "Google Earth Engine is not available right now. Tell the user; restarting GeoCode may fix it.",
        ],
      ]
      for (const [error, message] of cases) {
        answer = () => [JSON.stringify({ type: "result", ok: false, error })]
        const done = yield* executeTool(registry, gee({ script: "x" }))
        expect(done.status).toBe("error")
        expect(done.error?.message).toBe(message)
      }
    }),
  )

  it.live("in the background, returns once the script begins and tells the conversation the answer when it ends", () =>
    Effect.gen(function* () {
      reset()
      const encoder = new TextEncoder()
      let end = () => {}
      answer = (body) =>
        body.method !== "gee.run"
          ? ran()
          : new ReadableStream({
              start: (controller) => {
                controller.enqueue(encoder.encode(`${progress({ begun: true })}\n`))
                end = () => {
                  controller.enqueue(encoder.encode(`${ran().join("\n")}\n`))
                  controller.close()
                }
              },
            })
      const registry = yield* Tool.Service
      const running = yield* executeTool(registry, gee({ script: "x", background: true }))
      expect(running).toMatchObject({
        status: "completed",
        content: [
          {
            text: `Task ${TASK} is running in the background. You will be notified with its answer when the run ends. DO NOT sleep, poll, or run task ${TASK} again before then. Work on something else, or tell the user what is running and end your response.`,
          },
        ],
        metadata: { status: "running" },
      })
      // Kept until the notification is in the conversation, so that a restart can still give it.
      expect(kv.size).toBe(1)
      noticed = yield* Deferred.make<void>()
      end()
      yield* Deferred.await(noticed)
      expect(notices).toMatchObject([
        {
          sessionID,
          description: "统计影像",
          text: `<geerun task="${TASK}" state="completed" description="统计影像">\nimages: 73\n\nFinished in 1 s.\n</geerun>`,
        },
      ])
      for (let turn = 0; turn < 100 && kv.size > 0; turn++) yield* Effect.sleep("10 millis")
      expect(kv.size).toBe(0)

      // A run that cannot start fails the call itself, as a shell that cannot spawn does.
      answer = (body) =>
        body.method !== "gee.run"
          ? ran()
          : [JSON.stringify({ type: "result", ok: false, error: { code: "task-busy", message: "busy" } })]
      const busy = yield* executeTool(registry, gee({ script: "x", background: true }))
      expect(busy).toMatchObject({ status: "error" })
      expect(notices).toHaveLength(1)

      // GeoEngine ends its runs as the app quits, often before the kernel: no "not available" now, the restart tells.
      answer = (body) =>
        body.method !== "gee.run"
          ? ran()
          : new ReadableStream({
              start: (controller) => {
                controller.enqueue(encoder.encode(`${progress({ begun: true })}\n`))
                end = () => {
                  const error = { code: "cancelled", message: "the run was cancelled" }
                  controller.enqueue(encoder.encode(`${JSON.stringify({ type: "result", ok: false, error })}\n`))
                  controller.close()
                }
              },
            })
      yield* executeTool(registry, gee({ script: "x", background: true }))
      const [marker] = [...kv.values()] as Array<{ id: string; notificationID: string }>
      end()
      expect((yield* (yield* Job.Service).wait({ id: marker!.id })).info?.status).toBe("cancelled")
      yield* Effect.sleep("50 millis")
      expect(notices).toHaveLength(1)
      expect(kv.get(`job.background/${marker!.notificationID}`)).toMatchObject({ status: "running" })
    }),
  )

  it.effect("after a restart, tells the conversation that a background run was stopped", () =>
    Effect.gen(function* () {
      reset()
      const jobs = yield* Job.Service
      const notificationID = SessionMessage.ID.create()
      kv.set(`job.background/${notificationID}`, {
        id: "job_geerun",
        notificationID,
        recovery: { kind: "geerun", sessionID, task: TASK, description: "统计影像" },
        status: "running",
      })
      // What the kernel reads back at start-up; a marker it cannot read would be passed over without a word.
      const [background] = yield* jobs.pendingBackground
      if (background?.recovery.kind !== "geerun") throw new Error("the marker was not read back")
      yield* GeeRunTool.recover(yield* Session.Service, jobs, background, background.recovery)
      expect(notices).toEqual([
        {
          id: notificationID,
          sessionID,
          description: "统计影像",
          text: `<geerun task="${TASK}" state="cancelled" description="统计影像">\nThe run was stopped because GeoCode restarted. Assets its exports already saved, or still save, stay in the task; run the script again to finish it.\n</geerun>`,
          metadata: { source: "geerun", task: TASK, state: "cancelled" },
          resume: false,
        },
      ])
      expect(kv.size).toBe(0)
    }),
  )
})
