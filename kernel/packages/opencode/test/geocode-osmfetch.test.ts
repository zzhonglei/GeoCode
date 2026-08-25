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

/* The osmfetch subagent's reach, asked of the permission engine rather than read off the config it is written in
 * (docs/TOOLS.md §3, §4.3; KERNEL.md §5.4). */

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
      // `describeTask` announces a subagent with no description as "should only be called manually by the user"
      // (tool/registry.ts), which is backwards for the only route to OSM data.
      expect(agent.description).toBeTruthy()
    }),
  )

  it.instance("GeoAgent may dispatch it, and plan may see it without dispatching freely", () =>
    Effect.gen(function* () {
      const geo = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))

      expect(Permission.evaluate("task", "osmfetch", geo!.permission).action).toBe("allow")

      // `ask` and not `deny`: `describeTask` drops a subagent the rule denies, and a planner that never learns
      // osmfetch exists cannot write a plan that uses it.
      expect(Permission.evaluate("task", "osmfetch", plan!.permission).action).toBe("ask")
    }),
  )

  it.instance("and the model is actually told so, in the task tool's own description", () =>
    Effect.gen(function* () {
      // The verdict above decides whether the name is offered; this is whether it arrives, since an empty list
      // still ships the "Available agent types" heading with nothing under it (docs/TOOLS.md §9).
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
      // The groups too, not just the tool list: visibility and execution are separate verdicts, and being offered
      // a tool that is denied on the way out is the shape a user reads as a broken agent.
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
      // Verifying a download is reading; running algorithms belongs to the agent that dispatched this one.
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
      // The unnamed half, and why the ruleset is a whitelist: an MCP tool a user connects next month is as much a
      // way out as webfetch, and no list of forbidden names can reach it.
      const agent = yield* osmfetch()
      expect(Permission.evaluate("some_server_some_tool", "*", agent.permission).action).toBe("deny")
    }),
  )

  it.instance("it cannot dispatch subagents, including itself", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      expect(Permission.evaluate("task", "osmfetch", agent.permission).action).toBe("deny")

      // And the engine adds its own: task.ts derives a `task: *` deny for any subagent whose ruleset never names
      // `task`, which ours does not — the wildcard above denies it without spelling the word.
      const derived = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: agent })
      expect(derived).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    }),
  )

  it.instance("the parent's own grants do not leak into it", () =>
    Effect.gen(function* () {
      // The exits above mean nothing unless dispatching from a session that HAS webfetch fails to hand it over:
      // the derivation keeps the parent's denies and its external_directory rules, and drops its allows.
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
      // The other half of the same rule, and why it is not simply "ignore the parent": a session the user has
      // narrowed stays narrow for the work it spawns.
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
    // "every file", because one call can write several and a taken name makes it write to a numbered one, so the
    // path that was asked for is not always the one that exists.
    expect(OSMFETCH_PROMPT).toMatch(/every file/i)
  })

  test("it requires the superset warning to be passed upward, and names no remedy of its own", () => {
    // The chain is tool → osmfetch → caller, and a note summarized away here reaches nobody. Never a clip: on a
    // download the narrowing (§6.4) leaves the note standing only where the other extents legitimately hold
    // features outside the boundary file, and a count is never narrowed back at all.
    expect(OSMFETCH_PROMPT).toMatch(/covers more ground/i)
    expect(OSMFETCH_PROMPT).not.toMatch(/clip/i)
  })

  test("it separates a missing environment from a failed download", () => {
    // osmfetch holds `geodata`, but ReadGeoData needs QGIS ready, so on a machine without it the verification step
    // cannot run — which is not the download's fault and must not be reported as its failure.
    expect(OSMFETCH_PROMPT).toMatch(/QGIS is not configured/i)
    expect(OSMFETCH_PROMPT).toMatch(/not a download failure|it is not one/i)
  })

  test("it points network work at the tools rather than the shell it also has", () => {
    // It holds bash, so this is a convention rather than a wall: the client spaces requests and fails over between
    // endpoints, and a burst of unspaced ones gets this machine refused by services everyone here depends on.
    expect(OSMFETCH_PROMPT).toMatch(/rate limits/i)
  })
})
