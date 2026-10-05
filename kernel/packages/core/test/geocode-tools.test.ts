import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { GeoTools } from "@opencode/core/geocode/tools"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
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

const geoToolsNode = makeLocationNode({
  name: "test/geocode-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GeoTools.Plugin)),
  deps: [Tool.node, Permission.node],
})
const permission = permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, geoToolsNode]), [Permission.node.replace(permission)]),
)

const reset = () => {
  assertions.length = 0
  calls.length = 0
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
