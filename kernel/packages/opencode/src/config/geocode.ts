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
        // No `prompt` yet — GeoAgent inherits the model-specific system prompt
        // for now. Its own persona is a separate, deliberate step.
      },
      // Disable upstream's `build` primary agent by config instead of deleting
      // its source: the kernel turns `disable` into a real removal, and the
      // upstream definition stays byte-identical for clean merges.
      build: {
        disable: true,
      },
    },
  } as ConfigV1.Info
}
