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

/* The osmfetch subagent (docs/TOOLS.md §3, §4.3; KERNEL.md §5.4).
 *
 * This is the ruleset KERNEL.md §5.4 refused to write until there were tools to
 * intercept: "在没有工具可以拦截的情况下编写拦截规则,等于把正确性寄托在阅读代码的
 * 自信上." The tools exist now, so every claim below is made by asking the
 * engine rather than by reading the config.
 *
 * Two things are being pinned. That the four OSM tools became reachable at all
 * — they have been registered and callable by nobody since they landed. And
 * that the reach stops where it is meant to: a whitelist, so that what this
 * agent must not touch does not have to be enumerated, including tools a user
 * connects later that nobody here can name.
 */

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
      // describeTask lists subagents with their description, and an agent with
      // none is announced as "should only be called manually by the user" —
      // which is exactly backwards for the only route to OSM data.
      expect(agent.description).toBeTruthy()
    }),
  )

  it.instance("GeoAgent may dispatch it, and plan may see it without dispatching freely", () =>
    Effect.gen(function* () {
      const geo = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))

      expect(Permission.evaluate("task", "osmfetch", geo!.permission).action).toBe("allow")

      // `ask`, never `deny`: registry.describeTask drops a subagent from the
      // list it shows the model when the rule denies it, and a planner that
      // does not know osmfetch exists cannot write a plan that uses it.
      expect(Permission.evaluate("task", "osmfetch", plan!.permission).action).toBe("ask")
    }),
  )

  it.instance("and the model is actually told so, in the task tool's own description", () =>
    Effect.gen(function* () {
      // The permission verdict above decides whether the name is offered; this
      // is whether it arrives. Until now the list was empty and the task tool
      // announced "Available agent types and the tools they have access to:"
      // followed by nothing — a tool the model could see and never use
      // (docs/TOOLS.md §9). One agent in the list is what closes that.
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
      // This is the moment the OSM group stops being dead weight: registered
      // since it landed, callable by nobody until now.
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
      // Verifying a download is reading; running algorithms is the calling
      // agent's job. This is also why the tools state a superset as a fact and
      // name no algorithm to fix it — the agent reading that sentence cannot
      // run one.
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
      // A whitelist is the only shape that holds here. A list of forbidden
      // tools cannot include the MCP servers a user connects next month, and
      // those are as much a way out as webfetch is.
      const agent = yield* osmfetch()
      expect(Permission.evaluate("some_server_some_tool", "*", agent.permission).action).toBe("deny")
    }),
  )

  it.instance("it cannot dispatch subagents, including itself", () =>
    Effect.gen(function* () {
      const agent = yield* osmfetch()
      expect(Permission.evaluate("task", "osmfetch", agent.permission).action).toBe("deny")

      // And the engine adds its own belt: task.ts appends a task deny for any
      // subagent whose ruleset does not name `task`, which ours does not — the
      // wildcard denies it without ever spelling the word.
      const derived = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: agent })
      expect(derived).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    }),
  )

  it.instance("the parent's own grants do not leak into it", () =>
    Effect.gen(function* () {
      // The exit only means anything if dispatching from an agent that HAS
      // webfetch does not hand webfetch over. subagent-permissions.ts keeps the
      // parent session's denies and drops its allows; this asserts the result
      // rather than the reading of it.
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
      // The other half of the same rule, and the reason it is not simply
      // "ignore the parent": a session the user has narrowed must stay narrow
      // for the work it spawns.
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
    // The discipline belongs to the agent that holds `geodata` for exactly this
    // purpose, not repeated in the copy of every tool it may call — repeated
    // copies drift, and the tool descriptions are asserted to be free of it.
    expect(OSMFETCH_PROMPT).toContain("ReadGeoData")
    // "every file", because one call can write several and a taken name makes
    // it write to a numbered one.
    expect(OSMFETCH_PROMPT).toMatch(/every file/i)
  })

  test("it requires the superset warning to be passed upward, and names no remedy of its own", () => {
    // The chain is tool → osmfetch → caller. The tool states the result covers
    // more ground than the boundary asked for; if osmfetch summarizes that note
    // away, nobody knows. What to DO about it belongs to the caller, and since
    // the automatic narrowing (§6.4) the answer is never a clip: in the one
    // shape that still reaches the note the other extents legitimately hold
    // features outside the boundary file, so cutting to it would delete exactly
    // those. This prompt went on telling the caller to clip well after the
    // narrowing landed, because the assertion here required the word.
    expect(OSMFETCH_PROMPT).toMatch(/covers more ground/i)
    expect(OSMFETCH_PROMPT).not.toMatch(/clip/i)
  })

  test("it separates a missing environment from a failed download", () => {
    // osmfetch holds `geodata`, but ReadGeoData needs QGIS ready. On a machine
    // where QGIS is not configured the verification step cannot run — which is
    // not the download's fault and must not be reported as its failure.
    expect(OSMFETCH_PROMPT).toMatch(/QGIS is not configured/i)
    expect(OSMFETCH_PROMPT).toMatch(/not a download failure|it is not one/i)
  })

  test("it points network work at the tools rather than the shell it also has", () => {
    // It has bash, so this is a convention rather than a wall — and the reason
    // is concrete: the client spaces requests and fails over between endpoints,
    // and a burst of unspaced ones gets the machine refused.
    expect(OSMFETCH_PROMPT).toMatch(/rate limits/i)
  })
})
