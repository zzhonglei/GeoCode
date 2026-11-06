export * as GeoAgents from "./agents.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { ClaudeSystemPrompt } from "../plugin/provider/claude-agent/language-model/system-prompt.js"
import { ClaudeProvider } from "../plugin/provider/claude-agent/provider.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import EXPLORE from "./explore.txt"
import PROMPT from "./system.txt"

/** GeoAgent, the default agent, which takes the place of OpenCode's build agent. */
export const id = Agent.ID.make("geoagent")

const explore = Agent.ID.make("explore")

/**
 * Runs before OpenCode's agent plugins, so GeoAgent is the first agent registered. With build closed, that makes it
 * the default: the kernel falls back on the first primary agent where no default is named, or where the user's config
 * names one that is not there.
 */
export const Plugin = define({
  id: "geocode.agent",
  effect: Effect.fn("GeoAgents.Plugin")(function* (ctx) {
    yield* ctx.agent.transform((editor) =>
      // Mode and permissions as AgentPlugin.Plugin gives build (plugin/agent.ts), whose place this takes.
      editor.update(id, (item) => {
        item.name = Agent.Name.make("GeoAgent")
        item.description = "The default agent for geographic data work."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      }),
    )
  }),
})

/**
 * Runs after AgentPlugin, whose explore subagent searches codebases. This one has it search geographic data in local
 * folders too, with readgeodata, which explore has since it asks as read.
 */
export const Explore = define({
  id: "geocode.agent.explore",
  effect: Effect.fn("GeoAgents.Explore")(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      // An update would make the agent where explore is not there.
      if (!editor.get(explore)) return
      editor.update(explore, (item) => {
        item.description =
          'Fast agent specialized for exploring codebases and geographic data. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx", "**/*.shp"), search code for keywords (eg. "API endpoints"), answer questions about the codebase (eg. "how do API endpoints work?"), or find geographic data in local folders and what it holds (eg. "which layers cover the study area?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = EXPLORE.trimEnd()
      })
    })
  }),
})

/**
 * Runs after OptimizePlugin, whose hooks put OpenCode's prompt or a model's own variant of it where an agent has no
 * prompt of its own. This one puts GeoCode's there instead, for every model. Claude Agent drops that part for Claude
 * Code's own prompt and adds the agent's prompt as its role, which its hooks, also before this, leave empty for an
 * agent without one; so there GeoCode's prompt goes in as the role.
 */
export const Prompt = define({
  id: "geocode.agent.prompt",
  effect: Effect.fn("GeoAgents.Prompt")(function* (ctx) {
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
        const prompt = SessionSystemPrompt.render(PROMPT, Object.keys(event.tools))
        if (event.model.providerID === ClaudeProvider.ID) event.options[ClaudeSystemPrompt.AGENT_OPTION] = prompt
        const system = event.system[0]
        if (!system) return
        event.system[0] = { ...system, text: prompt }
      }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})

/** Runs after the user's config, where an `agents.build` entry would make build again. */
export const Closed = define({
  id: "geocode.agent.closed",
  effect: Effect.fn("GeoAgents.Closed")(function* (ctx) {
    yield* ctx.agent.transform((editor) => editor.remove(Agent.defaultID))
  }),
})
