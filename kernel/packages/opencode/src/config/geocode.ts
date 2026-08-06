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
    // Geographic capability is closed by default and opened per agent group
    // below. The wildcard deny cannot be omitted: evaluate() falls back to
    // "ask" when NO rule matches, so without it an unauthorized agent calling
    // a geo tool would pop a permission prompt at the user instead of being
    // refused — a silent boundary failure (docs/TOOLS.md §4.2).
    permission: {
      "geo_*": "deny",
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
          // The QGIS group: ReadGeoData / QgisDoc / RunQgisAlgorithm ask under
          // geo_qgis_* keys. Agent-level rules merge after the global deny
          // above, so findLast picks this allow for GeoAgent and the deny for
          // everyone else (docs/TOOLS.md §4.2 ③). OSM stays with the osmfetch
          // subagent.
          "geo_qgis_*": "allow",
          // The GEE group, one tool for now. A group of its own rather than a
          // second entry under the QGIS wildcard, because the two answer to
          // different environments: turning one off is a statement about an
          // install the user does or does not have (docs/TOOLS.md §3).
          "geo_gee_*": "allow",
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
