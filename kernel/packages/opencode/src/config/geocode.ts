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
    // Session sharing uploads to a service GeoCode does not run. The module
    // itself is off (share/share-next.ts); this makes the config surface say
    // so too, so an attempt to share reports "disabled in configuration"
    // instead of silently handing back an empty URL.
    share: "disabled",
    /* Geographic capability is closed by default and opened per agent below.
     *
     * Four groups, one per readiness condition a user actually has: reading
     * geographic data, the QGIS processing engine, the public OSM services,
     * Earth Engine. The same four names appear in permission/index.ts, which
     * maps tool ids onto them so visibility and execution agree.
     *
     * None of these may be omitted: evaluate() falls back to "ask" when NO rule
     * matches, so a missing deny turns an unauthorized call into a permission
     * prompt at the user instead of a refusal — a silent boundary failure
     * (docs/TOOLS.md §4.2). A fifth group must add a fifth line here; there is
     * no common prefix left to catch it automatically, which is the price of
     * names a user can read.
     *
     * Merged FIRST, so a user's own config still wins — the same treatment
     * upstream gives every one of its own tools (agent.ts places the user's
     * rules last, and findLast makes last win). GeoCode does not invent a layer
     * upstream has no equivalent of. */
    permission: {
      geodata: "deny",
      qgis: "deny",
      osm: "deny",
      gee: "deny",
    },
    agent: {
      GeoAgent: {
        mode: "primary",
        description: "GeoCode's assistant for geographic work.",
        // Mirror the upstream `build` agent's opt-ins (its permission defaults
        // deny both): allow clarifying questions and entering plan mode.
        permission: {
          question: "allow",
          plan_enter: "allow",
          // Agent-level rules merge after the global denies above, so findLast
          // picks these allows for GeoAgent and the denies for everyone else
          // (docs/TOOLS.md §4.2 ③).
          geodata: "allow",
          qgis: "allow",
          gee: "allow",
          // No `osm`. Downloading from public services goes through the
          // osmfetch subagent, whose exit is narrowed and whose prompt carries
          // the verification discipline — so the four OSM tools are not just
          // refused here, they do not appear in GeoAgent's tool list at all
          // (docs/TOOLS.md §4.3).
        },
        // Deliberately no `prompt`: GeoAgent picks up prompt/geocode.txt through
        // the base-prompt selector in session/system.ts, which GeoCode returns
        // for every model. Setting one here would only duplicate that.
      },
      /* Plan mode keeps SEEING the geographic tools, and that is the point.
       *
       * Upstream's plan can see its edit tools — a tool vanishes only when the
       * last rule matching it is a wildcard deny, and plan's edit rules end in
       * a narrow allow for the plan file. A planner that cannot see what it
       * will later be able to do cannot write a usable plan.
       *
       * So the executing groups are `ask` rather than `deny`: visible, and
       * gated on the user at the moment of use. The reminder plan mode injects
       * already tells the model not to run them ("they do not want you to
       * execute YET"); this is what happens if it tries anyway.
       *
       * `doc:*` is allowed outright so looking up an algorithm never interrupts
       * planning — the pattern namespace geo-qgis-doc.ts carves for exactly
       * this. Reading geographic data is allowed for the same reason upstream
       * lets plan read files.
       */
      plan: {
        permission: {
          geodata: "allow",
          qgis: { "*": "ask", "doc:*": "allow" },
          gee: "ask",
          // `ask`, never `deny`: describeTask drops a subagent from the list
          // when the rule denies it (tool/registry.ts), and a planner that does
          // not know osmfetch exists cannot plan a download. Upstream makes
          // exactly this mistake in the other direction — its plan prompt tells
          // the model to launch `general` agents while its permission denies
          // them, so the name is in the instructions and not in the list.
          task: { osmfetch: "ask" },
          // No `osm`: the four OSM tools belong to the subagent, so they are
          // not in plan's list either. What plan sees is the subagent.
        },
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
