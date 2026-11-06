export * as GeoSkills from "./skills.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

/**
 * Runs after SkillPlugin, whose built-in report skill files an issue on OpenCode's repository with OpenCode's
 * diagnostics. A report skill of the user's own comes from their config, which is applied after this.
 */
export const Plugin = define({
  id: "geocode.skill",
  effect: Effect.fn("GeoSkills.Plugin")(function* (ctx) {
    yield* ctx.skill.transform((editor) => editor.remove("report"))
  }),
})
