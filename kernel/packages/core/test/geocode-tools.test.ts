import { afterAll, beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { GeeRunTool } from "@opencode/core/geocode/geerun"
import { GeeRunJob } from "@opencode/core/geocode/geerun-job"
import { GeeRunRpc } from "@opencode/core/geocode/geerun-rpc"
import { GeoRunActivity } from "@opencode/core/geocode/run-activity"
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
import { tmpdirScoped } from "./fixture/tmpdir"
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
/** The scope the plugin is started in, which the plugin service closes when the plugin's location is evicted. */
let pluginScope: Scope.Closeable | undefined
/** How the plugin answers the interface about the runs in the background. */
let runsRpc: { list: () => Effect.Effect<unknown>; stop: (input: { id: string }) => Effect.Effect<unknown> } | undefined

const geoToolsNode = makeLocationNode({
  name: "test/geocode-tools-plugin",
  layer: Layer.effectDiscard(
    registerToolPlugin(GeoTools.Plugin, {
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc client")
        },
        {
          register: (_definition: unknown, handlers: unknown) =>
            Effect.sync(() => {
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              runsRpc = handlers as NonNullable<typeof runsRpc>
              return { dispose: Effect.void, events: { emit: () => Effect.void } }
            }),
        },
      ),
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
    }).pipe(
      Effect.provideServiceEffect(
        Scope.Scope,
        Effect.flatMap(Scope.Scope, Scope.fork).pipe(Effect.tap((scope) => Effect.sync(() => (pluginScope = scope)))),
      ),
    ),
  ),
  deps: [
    Tool.node,
    Permission.node,
    FileAccess.node,
    Location.node,
    PermissionSaved.node,
    Job.node,
    GeeRunJob.node,
    Session.node,
    Bus.node,
  ],
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
/** What the kernel told the interface on its bus: a background run's progress, once its call has returned. */
const published: Array<{ readonly type: string; readonly data: unknown }> = []
const bus = Layer.mock(Bus.Service, {
  publish: (definition, data) =>
    Effect.sync(() => void published.push({ type: definition.type, data })).pipe(Effect.as({} as never)),
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
  AppNodeBuilder.build(LayerNode.group([Tool.node, geoToolsNode, Job.node, GeeRunJob.node, Session.node]), [
    Permission.node.replace(permission),
    PermissionSaved.node.replace(permissionSaved),
    KV.node.replace(kvStore),
    Session.node.replace(sessions),
    Bus.node.replace(bus),
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
  published.length = 0
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
})

const read = (input: Record<string, unknown>, session = sessionID) => ({
  sessionID: session,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-readgeodata", name: "readgeodata", input },
})

const result = (value: unknown) => [JSON.stringify({ type: "result", ok: true, result: value })]

describe("GeoCode: readgeodata", () => {
  // Guards against an agent that may only read, such as Explore, not being offered it.
  it.effect("is offered wherever read is", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const tools = yield* toolDefinitions(registry, [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      expect(tools.map((tool) => tool.name)).toContain("readgeodata")
    }),
  )

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

  it.live("asks again about a dataset whose asking was interrupted", () =>
    Effect.gen(function* () {
      reset()
      answer = () => result({ text: "dem.tif: raster, GeoTIFF" })
      const registry = yield* Tool.Service
      const session = Session.ID.make("ses_geocode_tools_interrupted")
      const outside = path.join(path.parse(PROJECT).root, "survey", "dem.tif")
      pending = yield* Deferred.make<void>()
      const asking = yield* Effect.forkChild(executeTool(registry, read({ path: outside }, session)))
      // Interrupted while asking, not before it asks.
      for (let turn = 0; turn < 100 && !assertions.length; turn++) yield* Effect.sleep("10 millis")
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

  it.effect("remembers for a run writing into another repository only the directory its card names", () =>
    Effect.gen(function* () {
      reset()
      const repository = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(path.join(repository.path, ".git")))
      const results = path.join(repository.path, "results")
      engine({
        prepare: {
          plan: plan({
            outputs: [{ name: "OUTPUT", value: "x", files: [path.join(results, "a.gpkg")], folder: false }],
          }),
        },
      })
      yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} }))
      // Guards against "always allow" reaching every other directory of that repository without asking.
      expect(assertions[0]).toMatchObject({ save: [path.join(results, "*")] })
    }).pipe(Effect.scoped),
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
    }),
  )

  it.effect("keeps the end of what QGIS said, within the kernel's bounds, and how the run ended", () =>
    Effect.gen(function* () {
      reset()
      const ending = "Failed after 9 s.\nINPUT: Input layer (vector, required)"
      engine({
        run: () => [
          ...Array.from({ length: 3000 }, (_, index) =>
            progress({ level: "warning", text: `Feature ${index} has invalid geometry. Skipping feature.` }),
          ),
          progress({ level: "error", text: "No features left to buffer" }),
          JSON.stringify({
            type: "result",
            ok: false,
            error: { code: "algorithm-failed", message: "x", details: { ending } },
          }),
        ],
      })
      const done = yield* executeTool(yield* Tool.Service, runs({ algorithm: "native:buffer", parameters: {} }))
      const first = done.content?.[0]
      const text = first?.type === "text" ? first.text : ""
      expect(text).toContain("No features left to buffer")
      expect(text.endsWith(ending)).toBe(true)
      expect(text.split("\n").length).toBeLessThanOrEqual(ToolOutput.MAX_LINES)
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
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
          content: [{ text: expect.stringContaining("\nstarted\n") }],
          metadata: { outcome: "timeout" },
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

  // Guards against the kernel evicting the location of a long run, which sends no session event, and stopping the run.
  it.live("keeps its location from looking idle while it runs", () =>
    Effect.gen(function* () {
      reset()
      const begun = yield* Deferred.make<void>()
      let end = () => {}
      engine({
        run: () =>
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode(`${progress({ begun: true })}\n`))
              end = () => {
                controller.enqueue(new TextEncoder().encode(`${result({ ending: "Finished in 1 s." }).join("\n")}\n`))
                controller.close()
              }
              Effect.runSync(Deferred.succeed(begun, undefined))
            },
          }),
      })
      const running = yield* executeTool(
        yield* Tool.Service,
        runs({ algorithm: "native:buffer", parameters: {} }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(begun)
      expect(GeoRunActivity.isActive(Location.Ref.make({ directory: PROJECT }))).toBe(true)
      end()
      yield* Fiber.join(running)
      expect(GeoRunActivity.isActive(Location.Ref.make({ directory: PROJECT }))).toBe(false)
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

/** The Python a run went in, as GeoEngine tells it. */
const PYTHON = {
  path: "/opt/anaconda3/envs/map/bin/python",
  version: "3.11.9",
  packages: { "earthengine-api": "1.7.19", geedim: "2.0.0", geopandas: "1.0.1" },
}

/** A finished run of GeoEngine's, with what the script printed. */
const ran = (fields: Record<string, unknown> = {}) =>
  result({
    outcome: "finished",
    output: "images: 73\n",
    truncated: false,
    durationMs: 1200,
    python: PYTHON,
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
      const done = yield* executeTool(registry, gee({ script: "print(1)" }))
      expect(done).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: expect.stringContaining("images: 73") }],
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
      expect((yield* executeTool(registry, start)).status).toBe("error")
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
    }),
  )

  it.effect("runs nothing when the user refuses", () =>
    Effect.gen(function* () {
      reset()
      refused = "geerun"
      expect((yield* executeTool(yield* Tool.Service, gee({ script: "print(1)" }))).status).toBe("error")
      expect(calls.map((call) => call.body)).toMatchObject([{ method: "gee.check" }])
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
        // The error at the end is kept, however much came before it and however long the header.
        expect(text).toContain("ZeroDivisionError")
        expect(text.split("\n").length).toBeLessThanOrEqual(ToolOutput.MAX_LINES)
        expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
        expect(done.metadata).toMatchObject({ truncated: true })
      }
    }),
  )

  it.effect("folds a line printed over and over before cutting the start of an output too long to keep whole", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      answer = () => ran({ output: ["start", ...Array.from({ length: 5000 }, () => "waiting"), "done"].join("\n") })
      const long = yield* executeTool(registry, gee({ script: "x" }))
      const first = long.content?.[0]
      const text = first?.type === "text" ? first.text : ""
      expect(text).toContain("start")
      expect(text).toContain("done")
      expect(long.metadata).toMatchObject({ truncated: false })
      // Guards against folding an output that fits.
      answer = () => ran({ output: ["waiting", "waiting", "waiting"].join("\n") })
      const short = (yield* executeTool(registry, gee({ script: "x" }))).content?.[0]
      expect(short?.type === "text" ? short.text : "").toContain("waiting\nwaiting\nwaiting")
    }),
  )

  // Guards against the kernel evicting the location of a long run, which sends no session event, and stopping the run.
  it.live("keeps its location from looking idle while it runs", () =>
    Effect.gen(function* () {
      reset()
      const begun = yield* Deferred.make<void>()
      let end = () => {}
      answer = (body) =>
        body.method !== "gee.run"
          ? ran()
          : new ReadableStream({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode(`${progress({ begun: true })}\n`))
                end = () => {
                  controller.enqueue(new TextEncoder().encode(`${ran().join("\n")}\n`))
                  controller.close()
                }
                Effect.runSync(Deferred.succeed(begun, undefined))
              },
            })
      const running = yield* executeTool(yield* Tool.Service, gee({ script: "x" })).pipe(Effect.forkScoped)
      yield* Deferred.await(begun)
      expect(GeoRunActivity.isActive(Location.Ref.make({ directory: PROJECT }))).toBe(true)
      end()
      yield* Fiber.join(running)
      expect(GeoRunActivity.isActive(Location.Ref.make({ directory: PROJECT }))).toBe(false)
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
                  controller.enqueue(encoder.encode(`${progress({ output: "images: 73\n" })}\n`))
                  controller.enqueue(encoder.encode(`${ran().join("\n")}\n`))
                  controller.close()
                }
              },
            })
      const registry = yield* Tool.Service
      // As the kernel does: progress through a call once it has returned is refused.
      let returned = false
      const running = yield* executeTool(registry, {
        ...gee({ script: "x", background: true }),
        progress: () => (returned ? Effect.die(new Error("Tool progress outside running call")) : Effect.void),
      })
      returned = true
      expect(running).toMatchObject({
        status: "completed",
        metadata: { status: "running", started: expect.any(Number) },
      })
      // Kept until the notification is in the conversation, so that a restart can still give it.
      expect(kv.size).toBe(1)
      noticed = yield* Deferred.make<void>()
      end()
      yield* Deferred.await(noticed)
      // Guards against the row left running by the answer hearing nothing more of the run, or not when it ended.
      expect(published.filter((event) => event.type === "session.tool.progress").at(-1)).toMatchObject({
        type: "session.tool.progress",
        data: {
          sessionID,
          assistantMessageID: toolIdentity.messageID,
          id: "call-geerun",
          metadata: { status: "running", log: "images: 73\n" },
        },
      })
      expect(notices).toMatchObject([
        {
          sessionID,
          description: "统计影像",
          // The interface takes the answer out of this envelope, by an opening tag it rebuilds from the same fields.
          text: expect.stringMatching(
            new RegExp(
              `^<geerun task="${TASK}" state="completed" description="统计影像">\\n[\\s\\S]*images: 73[\\s\\S]*\\n</geerun>$`,
            ),
          ),
          metadata: {
            source: "geerun",
            state: "completed",
            callID: "call-geerun",
            outcome: "finished",
            started: expect.any(Number),
            ended: expect.any(Number),
            log: "images: 73\n",
          },
        },
      ])
      for (let turn = 0; turn < 100 && kv.size > 0; turn++) yield* Effect.sleep("10 millis")
      expect(kv.size).toBe(0)
      // Guards against a running row told of again after the notice ended it.
      const told = published.length
      yield* Effect.sleep("300 millis")
      expect(published).toHaveLength(told)

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

  // Guards against the notification being lost when the plugin that started the run is gone, as its location's eviction does.
  it.live("in the background, tells the conversation the answer though the plugin that started the run is gone", () =>
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
      yield* executeTool(yield* Tool.Service, gee({ script: "x", background: true }))
      yield* Scope.close(pluginScope!, Exit.void)
      noticed = yield* Deferred.make<void>()
      end()
      yield* Deferred.await(noticed)
      expect(notices).toHaveLength(1)
    }),
  )

  // Guards against the interface showing no run in the background, or one that has ended.
  it.live("lists a run while it goes on in the background, and tells of each change", () =>
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
      const told = () => published.filter((event) => event.type === "rpc.geocode.geeruns.changed").at(-1)?.data
      yield* executeTool(yield* Tool.Service, gee({ script: "x", description: "统计影像", background: true }))
      const listed = Schema.decodeUnknownSync(GeeRunRpc.Snapshot)(yield* runsRpc!.list())
      expect(listed.runs).toEqual([
        { id: expect.any(String), sessionID, description: "统计影像", startedAt: expect.any(Number) },
      ])
      expect(told()).toEqual(listed)
      noticed = yield* Deferred.make<void>()
      end()
      yield* Deferred.await(noticed)
      const ended = Schema.decodeUnknownSync(GeeRunRpc.Snapshot)(yield* runsRpc!.list())
      expect(ended.runs).toEqual([])
      // The interface keeps the latest list by its revision.
      expect(ended.revision).toBeGreaterThan(listed.revision)
      expect(told()).toEqual(ended)
    }),
  )

  // Guards against a run the user stopped going on, or its conversation told nothing, as of a run the app's quitting stopped.
  it.live("stops a run in the background at the user's word, and tells the conversation so", () =>
    Effect.gen(function* () {
      reset()
      const encoder = new TextEncoder()
      answer = (body) =>
        body.method !== "gee.run"
          ? ran()
          : new ReadableStream({
              start: (controller) => controller.enqueue(encoder.encode(`${progress({ begun: true })}\n`)),
            })
      yield* executeTool(yield* Tool.Service, gee({ script: "x", description: "统计影像", background: true }))
      const [run] = Schema.decodeUnknownSync(GeeRunRpc.Snapshot)(yield* runsRpc!.list()).runs
      noticed = yield* Deferred.make<void>()
      yield* runsRpc!.stop({ id: run!.id })
      yield* Deferred.await(noticed)
      for (let turn = 0; turn < 100 && !aborted.includes("gee.run"); turn++) yield* Effect.sleep("10 millis")
      expect(aborted).toContain("gee.run")
      expect(notices).toMatchObject([
        {
          sessionID,
          description: "统计影像",
          text: `<geerun task="${TASK}" state="cancelled" description="统计影像">\n${GeeRunTool.STOPPED}\n</geerun>`,
          metadata: { source: "geerun", state: "cancelled", callID: "call-geerun", ended: expect.any(Number) },
        },
      ])
      // As a background command's: the stop's notice wakes the conversation.
      expect(notices[0]?.resume).not.toBe(false)
      for (let turn = 0; turn < 100 && kv.size > 0; turn++) yield* Effect.sleep("10 millis")
      expect(kv.size).toBe(0)
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
        recovery: { kind: "geerun", sessionID, task: TASK, description: "统计影像", callID: "call-geerun" },
        status: "running",
      })
      // What the kernel reads back at start-up; a marker it cannot read would be passed over without a word.
      const [background] = yield* jobs.pendingBackground
      if (background?.recovery.kind !== "geerun") throw new Error("the marker was not read back")
      yield* GeeRunTool.recover(yield* Session.Service, jobs, background, background.recovery)
      expect(notices).toMatchObject([
        {
          id: notificationID,
          sessionID,
          description: "统计影像",
          // Guards against the row the run left running staying so after the restart.
          metadata: {
            source: "geerun",
            task: TASK,
            state: "cancelled",
            callID: "call-geerun",
          },
          resume: false,
        },
      ])
      expect(kv.size).toBe(0)
    }),
  )
})
