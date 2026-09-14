export * as GeoCodeConfig from "./geocode"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import OSMFETCH_PROMPT from "../session/prompt/osmfetch.txt"
import SET_COMMAND_TEMPLATE from "../command/template/set.txt"

/* --- GeoCode: the agents this product ships, as opposed to ones a user wrote. `agent.ts` marks
 * everything it builds from `cfg.agent` as `native: false`, which is right for a user's own agent and
 * wrong for these two — the desktop shell files a non-native agent under "custom", badges it with its
 * config scope instead of "system", and offers Rename and Delete on it rather than Reset.
 *
 * Spelled out rather than derived from `base().agent` below, because that object holds three kinds and
 * only this kind qualifies: `plan` and `explore` are upstream's own and already native, and `build` and
 * `general` appear there only to be disabled.
 *
 * `native` is presentation, not behaviour: the kernel reads it in exactly one other place, to sort
 * `opencode agent list`. --- */
export const shippedAgents: ReadonlySet<string> = new Set(["GeoAgent", "osmfetch"])

/* --- GeoCode: the agent lineup as configuration rather than as edits to upstream's agent table
 * (docs/KERNEL.md §3, §5.1). Merged FIRST in the config pipeline (config.ts), so everything here is a
 * default the user's own config still overrides. --- */
export function base(): ConfigV1.Info {
  return {
    // Named explicitly because `build` is disabled below and the fallback picks the first visible
    // primary agent, which would be `plan` (agent/agent.ts).
    default_agent: "GeoAgent",
    // The module is off in share/share-next.ts; saying so on the config surface too makes share/session.ts
    // refuse first, naming the configuration rather than the env var the gate below it names.
    share: "disabled",
    // The desktop shell files these under built-in commands by name (ui/src/geocode/slash-command-surface.ts).
    command: {
      set: { template: SET_COMMAND_TEMPLATE },
    },
    /* Closed here, opened per agent below; the same four names appear in permission/index.ts, which maps tool
     * ids onto them so visibility and execution agree. None may be omitted: every agent's ruleset starts from
     * the engine's `"*": "allow"` (agent/agent.ts) and `findLast` always reaches it, so a missing deny is a
     * silent allow rather than the `evaluate` fallback's prompt — and the four names share no common prefix
     * that a fifth group would be caught by (docs/TOOLS.md §4.2 ②). */
    permission: {
      geodata: "deny",
      qgis: "deny",
      osm: "deny",
      gee: "deny",
      // The browser tool's id and key are the same word, so it needs no row in permission/index.ts.
      browser: "deny",
    },
    agent: {
      GeoAgent: {
        mode: "primary",
        description: "GeoCode's assistant for geographic work.",
        // The engine's defaults deny both (agent/agent.ts); upstream opts back in on `build`, which GeoAgent
        // replaces.
        permission: {
          question: "allow",
          plan_enter: "allow",
          // Agent-level rules merge after the global denies above, so findLast picks these (docs/TOOLS.md
          // §4.2 ③).
          geodata: "allow",
          /* What the pattern namespace is for: a lookup changes nothing and never spends a prompt, while a run
           * asks because `QgisDestination.reserve` recognises outputs by parameter type and is silent about
           * the rest, leaving the dialog as the only guard there (docs/TOOLS.md §4.3). */
          qgis: { "*": "ask", "doc:*": "allow" },
          /* Grants the capability rather than the operation: a GEE script is arbitrary Python holding its
           * output path in a string literal, so the dialog can only say that Earth Engine is about to run
           * (cli/cmd/run/permission.shared.ts), and `always: ["*"]` in geo-gee-run.ts keeps it to one prompt
           * per app run. */
          gee: "ask",
          /* Allowed outright, the way upstream ships it: a click reaches nothing this agent could not already
           * reach, since `bash` is unnamed here and falls through to the engine's allow (docs/DESKTOP.md §7.2). */
          browser: "allow",
          // No `osm`: downloads go through the osmfetch subagent, and the wildcard deny above also keeps the
          // four OSM tools out of GeoAgent's tool list (docs/TOOLS.md §4.2 ①).
        },
      },
      /* The only agent that reaches the public OSM services, and its exit is a whitelist rather than a list of
       * forbidden things: `webfetch`, `websearch`, `task` and any MCP tool a user connects later are unnamed
       * and therefore denied by the wildcard below (docs/KERNEL.md §5.1). */
      osmfetch: {
        mode: "subagent",
        description:
          "Retrieves OpenStreetMap data: finds places and features by name, sizes a download before making it, and downloads objects by id or features by area and tag. Everything that comes from OSM goes through this agent — no other agent can reach those services. Give it the area or the names, where to write, and what the data is for.",
        prompt: OSMFETCH_PROMPT,
        permission: {
          "*": "deny",
          osm: "allow",
          // Its prompt requires verifying every file the report names, with ReadGeoData, before reporting.
          geodata: "allow",
          bash: "allow",
          glob: "allow",
          // The wildcard deny above also swallows the engine's `external_directory` rules; this puts back
          // upstream's ask, so an ordinary output path outside the worktree is not flatly refused.
          external_directory: "ask",
        },
      },
      /* The executing groups are `ask` rather than `deny` so plan keeps SEEING them: only a wildcard deny
       * removes a tool from the model's list (docs/TOOLS.md §4.2 ①), and a planner that cannot see what will
       * later be available cannot write a usable plan. Not running them is what plan.txt already says. */
      plan: {
        permission: {
          geodata: "allow",
          qgis: { "*": "ask", "doc:*": "allow" },
          gee: "ask",
          // `ask` and not `deny`, because describeTask drops a subagent whose `task` rule denies it
          // (tool/registry.ts) and a planner that does not know osmfetch exists cannot plan a download.
          // `explore` is left unnamed and falls through to the engine's allow: it only reads.
          task: { osmfetch: "ask" },
          // Reading the web is research, which is what planning is; it changes nothing on disk.
          browser: "allow",
        },
      },
      /* Kept rather than disabled, because it is the far end of upstream's context offloading: `grep.txt` and
       * `glob.txt` send open-ended searches to the task tool and the overflow hint in tool/truncate.ts names
       * this agent. `geodata` is the whole of the change to its reach — it narrows a folder of candidates, so
       * `qgis`, `gee` and `osm` stay on the global deny above (docs/KERNEL.md §5.1). */
      explore: {
        /* A full copy of upstream's description with two edits, because agent.ts assigns the field wholesale
         * and one sentence cannot be extended without restating all of them. Copies drift in silence, so
         * geocode-brand.test.ts applies the same two edits to upstream's source and diffs. */
        description: `Fast agent specialized for exploring codebases and geographic datasets. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), answer questions about the codebase (eg. "how do API endpoints work?"), or find relevant datasets in a folder of geographic data (eg. "which of these might be useful for this study?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        permission: {
          geodata: "allow",
        },
      },
      // Disabled by config rather than by deleting definitions that stay byte-identical for merges; `disable`
      // deletes the agent outright (agent/agent.ts).
      build: {
        disable: true,
      },
      general: {
        disable: true,
      },
    },
  } as ConfigV1.Info
}
