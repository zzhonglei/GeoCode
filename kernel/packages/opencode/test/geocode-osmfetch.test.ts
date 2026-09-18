import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { deriveSubagentSessionPermission } from "../src/agent/subagent-permissions"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { GeoKernel } from "../src/geo"
import OSMFETCH_PROMPT from "../src/session/prompt/osmfetch.txt"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

// Asked of the permission engine rather than read off the config, where a missing deny looks harmless but evaluates
// to allow (docs/TOOLS.md §4.3).

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

const osmfetch = Effect.fnUntraced(function* () {
  const agent = yield* Agent.Service.use((svc) => svc.get("osmfetch"))
  expect(agent).toBeDefined()
  return agent!
})

/** What the model is actually offered, after the visibility layer has run. */
const toolsOf = Effect.fnUntraced(function* (name: string) {
  const registry = yield* ToolRegistry.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  const ids = (yield* registry.all()).map((tool) => tool.id)
  const hidden = Permission.disabled(ids, agent!.permission)
  return ids.filter((id) => !hidden.has(id))
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("osmfetch exists and is reachable", () => {
  it.instance("it is a subagent, not a second primary", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      expect(agent.mode).toBe("subagent")
      // Without one, describeTask tells the model this subagent should only be called manually by the user.
      expect(agent.description).toBeTruthy()
    }),
  )

  it.instance("GeoAgent may dispatch it, and plan may see it without dispatching freely", () =>
    Effect.gen(function* () {
      const geo = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))

      expect(Permission.evaluate("task", "osmfetch", geo!.permission).action).toBe("allow")

      // ask, not deny: describeTask drops a denied subagent, and a planner unaware of osmfetch cannot plan with it.
      expect(Permission.evaluate("task", "osmfetch", plan!.permission).action).toBe("ask")
    }),
  )

  it.instance("and the model is actually told so, in the task tool's own description", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const name of ["GeoAgent", "plan"]) {
        const agent = yield* Agent.Service.use((svc) => svc.get(name))
        const tools = yield* registry.tools({
          providerID: "anthropic" as never,
          modelID: "claude-sonnet-4-5" as never,
          agent: agent!,
        })
        const task = tools.find((tool) => tool.id === "task")
        expect(task).toBeDefined()
        expect(task!.description).toContain("osmfetch")
      }
    }),
  )
})

describe("what osmfetch can reach", () => {
  it.instance("the four OSM tools, and the one it verifies with", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOf("osmfetch")
      for (const id of ["OsmSearch", "OsmProbe", "OsmGetObjects", "OsmGetFeatures", "ReadGeoData"]) {
        expect(tools).toContain(id)
      }
      // Execution is a verdict separate from visibility, and a tool offered but then denied reads as a broken agent.
      expect(Permission.evaluate("osm", "*", (yield* osmfetch()).permission).action).toBe("allow")
      expect(Permission.evaluate("geodata", "*", (yield* osmfetch()).permission).action).toBe("allow")
    }),
  )

  it.instance("a shell and a way to look around, because a downloader needs both", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOf("osmfetch")
      expect(tools).toContain("bash")
      expect(tools).toContain("glob")
    }),
  )

  it.instance("no processing engine", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOf("osmfetch")
      expect(tools).not.toContain("RunQgisAlgorithm")
      expect(tools).not.toContain("QgisDoc")
      expect(tools).not.toContain("RunGeeScript")
      expect(Permission.evaluate("qgis", "*", (yield* osmfetch()).permission).action).toBe("deny")
    }),
  )
})

describe("where the reach stops", () => {
  it.instance("the named ways out are gone, and so is everything unnamed", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOf("osmfetch")
      for (const id of ["webfetch", "websearch", "task", "skill", "edit", "write", "apply_patch"]) {
        expect(tools).not.toContain(id)
      }
      // An MCP tool the user connects later is as much a way out as webfetch, and no list of names can reach it.
      const agent = yield* osmfetch()
      expect(Permission.evaluate("some_server_some_tool", "*", agent.permission).action).toBe("deny")
    }),
  )

  it.instance("it cannot dispatch subagents, including itself", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      expect(Permission.evaluate("task", "osmfetch", agent.permission).action).toBe("deny")

      // The engine adds its own task deny only while osmfetch's ruleset never names task.
      const derived = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: agent })
      expect(derived).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    }),
  )

  it.instance("the parent's own grants do not leak into it", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      const parentSessionPermission = Permission.fromConfig({ webfetch: "allow", "*": "allow" })
      const derived = deriveSubagentSessionPermission({ parentSessionPermission, subagent: agent })
      const merged = Permission.merge(agent.permission, derived)
      expect(Permission.evaluate("webfetch", "*", merged).action).toBe("deny")
      expect(Permission.evaluate("osm", "*", merged).action).toBe("allow")
    }),
  )

  it.instance("a parent's restriction still reaches it", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      const derived = deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ osm: "deny" }),
        subagent: agent,
      })
      expect(Permission.evaluate("osm", "*", Permission.merge(agent.permission, derived)).action).toBe("deny")
    }),
  )
})

describe("the prompt it works under", () => {
  test("it carries the verification discipline, which lives here and not in eight tool descriptions", () => {
    expect(OSMFETCH_PROMPT).toContain("ReadGeoData")
    // One call can write several files, and a taken name moves the output to a numbered one.
    expect(OSMFETCH_PROMPT).toMatch(/every file/i)
  })

  test("it requires the superset warning to be passed upward, and names no remedy of its own", () => {
    // Never a clip: the other extents legitimately hold features outside the boundary file, which clipping deletes.
    expect(OSMFETCH_PROMPT).toMatch(/covers more ground/i)
    expect(OSMFETCH_PROMPT).not.toMatch(/clip/i)
  })

  test("it separates a missing environment from a failed download", () => {
    expect(OSMFETCH_PROMPT).toMatch(/QGIS is not configured/i)
    expect(OSMFETCH_PROMPT).toMatch(/not a download failure|it is not one/i)
  })

  test("it points network work at the tools rather than the shell it also has", () => {
    // Only a convention, since it holds bash: the OSM client spaces its requests, and an unspaced burst gets refused.
    expect(OSMFETCH_PROMPT).toMatch(/rate limits/i)
  })
})
