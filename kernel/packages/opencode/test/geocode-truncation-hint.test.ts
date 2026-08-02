import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Agent } from "../src/agent/agent"
import { Auth } from "../src/auth"
import { Config } from "../src/config/config"
import { Plugin } from "../src/plugin"
import { Provider } from "../src/provider/provider"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { Skill } from "../src/skill"
import { Truncate } from "../src/tool/truncate"
import { testEffect } from "./lib/effect"

/* Tripwire for the merged overflow hint in tool/truncate.ts.
 *
 * Upstream's hint for agents holding the task tool names the explore agent —
 * disabled in GeoCode — and forbids reading the saved file directly, which
 * leaves the model with a dead route and a ban on the live one. The patch
 * merges the two branches; this test goes red if an upstream merge restores
 * the original wording.
 *
 * It reads the agent the assembly layer actually produces, not a hand-built
 * ruleset: GeoAgent holds the task tool through the defaults, so upstream's
 * code would have picked the explore-agent branch for exactly this agent.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      Truncate.node,
      FSUtil.node,
      filesystem,
    ]),
  ),
)

/** Comfortably past MAX_LINES so the overflow path runs regardless of byte size. */
const OVERFLOWING = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n")

describe("truncation hint", () => {
  it.instance("never names a deleted agent, and always offers a route that works", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const geo = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      expect(geo).toBeDefined()

      const withTask = yield* truncate.output(OVERFLOWING, {}, geo)
      expect(withTask.truncated).toBe(true)
      expect(withTask.content).not.toContain("explore")
      expect(withTask.content).toContain("Grep")
      // Delegation stays on offer — as an addition, not a replacement.
      expect(withTask.content).toContain("Task tool")
      expect(withTask.content).not.toContain("Do NOT")

      // No agent info means no task tool: same route, no delegation line.
      const without = yield* truncate.output(OVERFLOWING)
      expect(without.truncated).toBe(true)
      expect(without.content).toContain("Grep")
      expect(without.content).not.toContain("Task tool")
    }),
  )
})
