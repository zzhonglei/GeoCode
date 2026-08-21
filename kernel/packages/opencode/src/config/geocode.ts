export * as GeoCodeConfig from "./geocode"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import OSMFETCH_PROMPT from "../session/prompt/osmfetch.txt"

/* --- GeoCode: the factory assembly layer. This is where GeoCode's identity is
 * expressed as configuration rather than by editing upstream agent code, so the
 * agent engine in kernel/ stays a thin fork (docs/KERNEL.md §3, docs/PATHS.md §5).
 *
 * `base()` is merged FIRST in the config pipeline (config.ts), so anything here
 * is an out-of-the-box default the user's own config can still override — model,
 * temperature, extra agents, and so on.
 *
 * There is deliberately NO second `enforced()` layer merged last. An earlier
 * version of this comment promised one "once geo tools exist"; the tools exist
 * now and the question settled the other way. Upstream sets no such layer over
 * any of its own tools, and the geographic denies below are meant to be
 * overridable for exactly the reason upstream's are: a user's own config wins,
 * and inventing a layer upstream has no equivalent of is not a decision this
 * fork gets to make quietly. geocode-geo-permissions.test.ts asserts that
 * property through the engine, so adding the layer would turn it red. --- */
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
     * None of these may be omitted, and the reason is worse than it reads.
     * `evaluate` does end in `?? { action: "ask" }`, but no real agent ever
     * reaches it: every ruleset is `merge(defaults, user)` and the engine's
     * defaults open with `"*": "allow"` (agent/agent.ts), which findLast always
     * matches. A missing deny is therefore not a prompt at the user — it is a
     * SILENT ALLOW. Measured: asking GeoAgent about a key nobody wrote a rule
     * for returns "allow" (docs/TOOLS.md §4.2). A fifth group must add a fifth
     * line here; there is no common prefix left to catch it automatically,
     * which is the price of names a user can read.
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
          /* The one group that asks, and the only permission in GeoCode that is
           * stricter than upstream's treatment of its own tools.
           *
           * Upstream sets no tool to `ask` — all seven built-in agents use only
           * `allow` and `deny`, and `edit`/`write`/`bash` land on the engine's
           * `"*": "allow"`. That is a defensible default THERE because a bad
           * edit is recoverable: the checkpoint mechanism holds a snapshot to
           * revert to. Geographic data is deliberately outside that mechanism
           * (§10.1 #6 — a scene per turn would dwarf the project), so the same
           * trade-off has a different answer here. "Do not destroy it in the
           * first place" is already why outputs are numbered rather than
           * overwritten; this is that same rule where numbering cannot reach.
           *
           * And it cannot reach far. `QgisDestination.reserve` finds outputs by
           * PARAMETER TYPE, which is sound for what it recognises and blind to
           * the rest: measured on a real 3.44 registry, 56 of 422 algorithms
           * declare no destination parameter and about 26 of those write
           * anyway. Since the catalog is built from whichever QGIS the user
           * installed, that blind spot cannot be closed by a list — only by
           * showing the call and letting the user decide (tool/geo-qgis-run.ts).
           *
           * `doc:*` stays open at all times: looking up an algorithm changes
           * nothing, and a prompt for it would train the user to dismiss
           * prompts. The pattern namespace exists for exactly this split, and
           * the shape is upstream's own — `read` is `{"*": "allow", "*.env":
           * "ask"}`, the same key divided by how much the operation can cost.
           * Plan mode already carries this exact rule. */
          qgis: { "*": "ask", "doc:*": "allow" },
          /* Asked too, but for a different reason and with a different prompt.
           *
           * QGIS is asked because the call can be READ: an algorithm id and its
           * parameters fit in a dialog, and judging them is the only guard left
           * where numbering cannot reach. None of that transfers here. A GEE
           * script is arbitrary Python — `download_image(image, "…", roi)` puts
           * the output path inside a string literal in the code, so nothing at
           * this layer can see it, and unfolding the script into a prompt would
           * only teach the user to confirm without reading.
           *
           * What is granted is therefore the CAPABILITY, not the operation:
           * running against the user's Earth Engine credentials and quota, and
           * writing imagery somewhere on their disk. That is worth one prompt —
           * scripts are rare next to algorithm calls, and `always` keeps it to
           * one per app run — and the prompt says exactly that much
           * (cli/cmd/run/permission.shared.ts), the way upstream's `task`
           * prompt names a subagent without pretending to know what it will do. */
          gee: "ask",
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
      /* The one agent that talks to the public OSM services.
       *
       * Not a convenience. Downloading is the part of geographic work with an
       * outside party in it — services with published rate limits, run by
       * volunteers — and it is the part whose result is hardest to check, since
       * a file of the wrong features looks exactly like a file of the right
       * ones. Both are better handled by something with one job, a prompt about
       * that job, and a much smaller reach than the agent it works for.
       *
       * The reach is a whitelist rather than a list of forbidden things.
       * `webfetch`, `websearch`, `task`, `skill`, editing — none of them are
       * named here, and neither is any MCP tool a user may connect later, which
       * is the point: what a locked agent must not touch cannot be enumerated
       * in advance, only what it needs can.
       *
       * `bash` and `glob` ARE granted, deliberately. A downloader needs to look
       * around a directory and move a file, and refusing that buys nothing that
       * matters — the parent agent has a shell too, so this was never a barrier
       * around the machine, only around this agent's habits. What the narrower
       * reach still buys is that the OSM tools are the obvious route, and they
       * are the route that keeps the rate limits.
       */
      osmfetch: {
        mode: "subagent",
        description:
          "Retrieves OpenStreetMap data: finds places and features by name, sizes a download before making it, and downloads objects by id or features by area and tag. Everything that comes from OSM goes through this agent — no other agent can reach those services. Give it the area or the names, where to write, and what the data is for.",
        prompt: OSMFETCH_PROMPT,
        permission: {
          "*": "deny",
          osm: "allow",
          // Reading back what it just wrote, which its prompt requires of it
          // before reporting success. Not `qgis`: verifying a download is
          // reading, and running processing algorithms is somebody else's job.
          geodata: "allow",
          bash: "allow",
          glob: "allow",
          // Restores upstream's default for paths outside the working
          // directory: ask the user, rather than the flat refusal the wildcard
          // above would otherwise produce for a perfectly ordinary output path.
          external_directory: "ask",
        },
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
      /* Upstream's read-only search subagent, kept — and given the one
       * geographic tool that is reading.
       *
       * It was disabled here at first, on the reasoning that code search has no
       * role in geographic work. Two things were wrong with that.
       *
       * The smaller one: users bring code. A remote-sensing processing project
       * is a directory of scripts like any other, and a user who hands one over
       * expects the agent to find its way around.
       *
       * The larger one: `explore` is not only an agent, it is the far end of
       * upstream's context-offloading mechanism. Three live hints send work to
       * it — `grep.txt`, `glob.txt` ("use the Task tool instead" for open-ended
       * searches) and the overflow hint in tool/truncate.ts. Disabling it left
       * all three telling the model to delegate, at a subagent list holding one
       * OSM downloader — and left the primary agent carrying every large output
       * in its own context window.
       *
       * `geodata` is the whole of the change to its reach. Everything else is
       * upstream's: `"*": "deny"` with grep/glob/list/read/bash/webfetch/
       * websearch opened, and `external_directory` at `ask`. What that buys is
       * "scan this directory and report what each dataset is" — a genuinely
       * context-heavy opening move in geographic work, done in somebody else's
       * context. Reading is also the whole of what it can do to that data:
       * `qgis`, `gee` and `osm` are left at the global deny above.
       *
       * ⚠️ Its prompt and description are still upstream's, and both talk about
       * codebases only. Rewriting them is a separate decision — a config-layer
       * one (agent.ts folds `prompt`/`description` in from here), not a patch. */
      explore: {
        permission: {
          geodata: "allow",
        },
      },
      // Disable upstream's remaining coding-oriented agents by config instead
      // of deleting their source: the kernel turns `disable` into a real
      // removal, and the upstream definitions stay byte-identical for clean
      // merges.
      //
      // `build` is replaced by GeoAgent above. `general` is a general-purpose
      // code-task subagent — unlike `explore` it is not read-only, and nothing
      // in the tree routes work to it by name; the task tool advertises its
      // subagent list dynamically, so removing it simply shrinks that list
      // rather than leaving a dangling name.
      build: {
        disable: true,
      },
      general: {
        disable: true,
      },
    },
  } as ConfigV1.Info
}
