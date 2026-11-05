export * as GeoAgents from "./agents.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import PROMPT from "./system.txt"

/** GeoAgent, the default agent, which takes the place of OpenCode's build agent. */
export const id = Agent.ID.make("geoagent")

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
 * Runs after OptimizePlugin, whose hooks put OpenCode's prompt or a model's own variant of it where an agent has no
 * prompt of its own. This one puts GeoCode's there instead, for every model.
 */
export const Prompt = define({
  id: "geocode.agent.prompt",
  effect: Effect.fn("GeoAgents.Prompt")(function* (ctx) {
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
        const system = event.system[0]
        if (!system) return
        event.system[0] = { ...system, text: SessionSystemPrompt.render(PROMPT, Object.keys(event.tools)) }
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
