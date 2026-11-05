export * as GeoPlan from "./plan.js"

import { ToolFailure } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { OsmGetTools } from "./osmget.js"
import ENTER from "./plan.txt"
import { QgisRunTool } from "./qgisrun.js"

const plan = Agent.ID.make("plan")

/** The reminder Plan mode starts with, in place of OpenCode's; PlanPlugin inserts it and knows it by its text. */
export const enter = (directory: string) => ENTER.trimEnd().replace("${directory}", directory)

/**
 * The geo tools that write data. Plan mode refuses them before they ask or run, rather than denying them, so they stay
 * on the tool list and switching to or from Plan keeps the provider's prompt cache.
 */
const WRITERS: ReadonlySet<string> = new Set([QgisRunTool.name, OsmGetTools.objectsName, OsmGetTools.featuresName])

/** Runs after PlanPlugin, whose Plan agent it changes. */
export const Plugin = define({
  id: "geocode.plan",
  effect: Effect.fn("GeoPlan.Plugin")(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      // An update would make the agent where Plan is not there.
      if (!editor.get(plan)) return
      editor.update(plan, (item) => {
        item.description = "Plans geographic work with you before it is carried out."
      })
    })
    yield* ctx.tool.hook("execute.before", (event) =>
      event.agent === plan && WRITERS.has(event.tool)
        ? Effect.fail(
            new ToolFailure({
              message: `${event.tool} does not run in Plan mode. To run it, the user has to switch to GeoAgent.`,
            }),
          )
        : Effect.void,
    )
  }),
})
