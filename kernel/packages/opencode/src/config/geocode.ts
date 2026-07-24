export * as GeoCodeConfig from "./geocode"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

/* --- GeoCode: the factory assembly layer. This is where GeoCode's identity is
 * expressed as configuration rather than by editing upstream agent code, so the
 * agent engine in kernel/ stays a thin fork (docs/KERNEL.md §3, docs/PATHS.md §5).
 *
 * `base()` is merged FIRST in the config pipeline (config.ts), so anything here
 * is an out-of-the-box default the user's own config can still override — model,
 * temperature, extra agents, and so on. Hard security rules that must NOT be
 * user-overridable will live in a separate `enforced()` layer merged LAST, once
 * geo tools exist; it is intentionally absent while there is nothing to lock. --- */
export function base(): ConfigV1.Info {
  return {
    // GeoAgent is the sole primary agent GeoCode surfaces.
    default_agent: "GeoAgent",
    agent: {
      GeoAgent: {
        mode: "primary",
        description: "GeoCode's assistant for geographic work.",
        // Mirror the upstream `build` agent's opt-ins (its permission defaults
        // deny both): allow clarifying questions and entering plan mode.
        permission: {
          question: "allow",
          plan_enter: "allow",
        },
        // Deliberately no `prompt`: GeoAgent picks up prompt/geocode.txt through
        // the base-prompt selector in session/system.ts, which GeoCode returns
        // for every model. Setting one here would only duplicate that.
      },
      // Disable upstream's coding-oriented agents by config instead of deleting
      // their source: the kernel turns `disable` into a real removal, and the
      // upstream definitions stay byte-identical for clean merges.
      //
      // `build` is replaced by GeoAgent above. `explore` and `general` are
      // code-search and code-task subagents with no role in geographic work;
      // the task tool advertises its subagent list dynamically, so removing
      // them simply shrinks that list rather than leaving a dangling name.
      build: {
        disable: true,
      },
      explore: {
        disable: true,
      },
      general: {
        disable: true,
      },
    },
  } as ConfigV1.Info
}
