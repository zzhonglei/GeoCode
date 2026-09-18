export * as GeoCodeConfig from "./geocode"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import OSMFETCH_PROMPT from "../session/prompt/osmfetch.txt"
import SET_COMMAND_TEMPLATE from "../command/template/set.txt"

/* --- GeoCode: agents the product ships, which agent.ts marks native so the desktop shell does not treat them as the
 * user's own; listed by hand because `base().agent` also holds upstream agents that are native already or only
 * disabled (docs/KERNEL.md §5.1). --- */
export const shippedAgents: ReadonlySet<string> = new Set(["GeoAgent", "osmfetch"])

/* --- GeoCode: the agent lineup as configuration, merged first in config.ts so the user's config overrides any of it
 * (docs/KERNEL.md §5.1). --- */
export function base(): ConfigV1.Info {
  return {
    // With `build` disabled below, the fallback would pick the first visible primary agent, `plan` (agent/agent.ts).
    default_agent: "GeoAgent",
    // Also off in share/share-next.ts; this makes share/session.ts refuse first, naming the configuration.
    share: "disabled",
    // The desktop shell files these under built-in commands by name (ui/src/geocode/slash-command-surface.ts).
    command: {
      set: { template: SET_COMMAND_TEMPLATE },
    },
    /* Closed here, opened per agent below; the four geo keys match the GEO map in permission/index.ts. None may be
     * omitted: every ruleset starts from the engine's `"*": "allow"`, so a missing deny is a silent allow
     * (docs/TOOLS.md §4.2). */
    permission: {
      geodata: "deny",
      qgis: "deny",
      osm: "deny",
      gee: "deny",
      // The browser and geocode tools' ids and keys are the same word, so neither needs a row in permission/index.ts.
      browser: "deny",
      geocode: "deny",
    },
    agent: {
      GeoAgent: {
        mode: "primary",
        description: "GeoCode's assistant for geographic work.",
        // The engine's defaults deny both; upstream opts back in on `build`, which GeoAgent replaces.
        permission: {
          question: "allow",
          plan_enter: "allow",
          // Agent rules merge after the global denies above, so findLast picks these (docs/TOOLS.md §4.2).
          geodata: "allow",
          // Lookups are allowed; runs ask, because the destination check sees only outputs it recognises by
          // parameter type and the dialog is the only guard for the rest (docs/TOOLS.md §4.3).
          qgis: { "*": "ask", "doc:*": "allow" },
          // A script is arbitrary Python, so the dialog can only ask whether Earth Engine may run at all, and
          // geo-gee-run.ts asks with `always: ["*"]` so one approval lasts the app run.
          gee: "ask",
          // Allowed as upstream ships it: `bash`, unnamed here and so allowed by the engine, already reaches whatever a
          // click could (docs/DESKTOP.md §7.2).
          browser: "allow",
          // Upstream's control tool, allowed outright the same way (docs/DESKTOP.md §7.2).
          geocode: "allow",
          // No `osm`: downloads go through osmfetch, and the global deny also hides the OSM tools from GeoAgent
          // (docs/TOOLS.md §4.2).
        },
      },
      /* The only agent that reads remote content, so its tools are a whitelist: `webfetch`, `websearch`, `task` and
       * any MCP tool connected later fall to the wildcard deny below (docs/TOOLS.md §4.4). */
      osmfetch: {
        mode: "subagent",
        description:
          "Retrieves OpenStreetMap data: finds places and features by name, sizes a download before making it, and downloads objects by id or features by area and tag. Everything that comes from OSM goes through this agent — no other agent can reach those services. Give it the area or the names, where to write, and what the data is for.",
        prompt: OSMFETCH_PROMPT,
        permission: {
          "*": "deny",
          osm: "allow",
          // Its prompt has it verify every file it reports with ReadGeoData.
          geodata: "allow",
          bash: "allow",
          glob: "allow",
          // Restores the engine's ask, which the wildcard deny overrides, so an output path outside the worktree is
          // not refused outright.
          external_directory: "ask",
        },
      },
      /* The executing groups ask rather than deny so plan still sees them, since only a wildcard deny hides a tool
       * (docs/TOOLS.md §4.2); plan.txt already tells it not to run them. */
      plan: {
        permission: {
          geodata: "allow",
          qgis: { "*": "ask", "doc:*": "allow" },
          gee: "ask",
          // `ask`, not `deny`: describeTask hides a subagent whose `task` rule denies it (tool/registry.ts), and a
          // planner that cannot see osmfetch cannot plan a download. `explore`, unnamed, only reads.
          task: { osmfetch: "ask" },
          // Reading the web is research, which is what planning is; it changes nothing on disk.
          browser: "allow",
        },
      },
      /* Kept, because grep.txt and glob.txt send open-ended searches to the task tool and tool/truncate.ts names this
       * agent; it gains only `geodata`, with `qgis`, `gee` and `osm` left on the global deny (docs/KERNEL.md §5.1). */
      explore: {
        // A copy of upstream's description with two edits, since agent.ts assigns the field wholesale;
        // geocode-brand.test.ts checks the copy against upstream's source.
        description: `Fast agent specialized for exploring codebases and geographic datasets. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), answer questions about the codebase (eg. "how do API endpoints work?"), or find relevant datasets in a folder of geographic data (eg. "which of these might be useful for this study?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        permission: {
          geodata: "allow",
        },
      },
      // Disabled here so agent.ts stays byte-identical; `disable` removes the agent outright (agent/agent.ts).
      build: {
        disable: true,
      },
      general: {
        disable: true,
      },
    },
  } as ConfigV1.Info
}
