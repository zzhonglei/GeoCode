import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { permissionInfo } from "../src/cli/cmd/run/permission.shared"
import { Agent } from "../src/agent/agent"
import { GeoCodeConfig } from "../src/config/geocode"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { MessageID, SessionID } from "../src/session/schema"
import { GeoKernel, GeoStatus } from "../src/geo"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"
import { GEE_READY, QGIS_READY, statusHolding } from "./lib/geocode-status"

/* The geographic permission model, both layers (docs/TOOLS.md §4).
 *
 * The engine decides two different things with two different names:
 *
 *   visibility — by TOOL ID, in Permission.disabled
 *   execution  — by the key the tool declares in ctx.ask, in Permission.evaluate
 *
 * GeoCode's ids and keys diverge on purpose: `ReadGeoData` is what the model
 * reads, `geodata` is what a user reasons about. A table in permission/index.ts
 * bridges them, and a missing entry there does not raise anything — the rule is
 * written, it is simply never consulted. So both layers are asserted here rather
 * than one being inferred from the other, and the table joining them is pinned
 * on its own, below.
 *
 * Read as a matrix: for every agent, which geographic tools it can SEE and
 * which it can USE.
 */

const GEO_TOOLS = [
  "ReadGeoData",
  "QgisDoc",
  "RunQgisAlgorithm",
  "RunGeeScript",
  "OsmSearch",
  "OsmProbe",
  "OsmGetObjects",
  "OsmGetFeatures",
] as const

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

/** Which of the geographic tools this agent is offered at all. */
const visible = Effect.fnUntraced(function* (name: string) {
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  expect(agent).toBeDefined()
  const hidden = Permission.disabled([...GEO_TOOLS], agent!.permission)
  return GEO_TOOLS.filter((tool) => !hidden.has(tool))
})

/** What the engine decides when this agent asks under `key` about `pattern`. */
const verdict = Effect.fnUntraced(function* (name: string, key: string, pattern = "*") {
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  expect(agent).toBeDefined()
  return Permission.evaluate(key, pattern, agent!.permission).action
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("what each agent can see", () => {
  it.instance("GeoAgent sees everything except the OSM group", () =>
    Effect.gen(function* () {
      // Downloading from public services goes through the osmfetch subagent —
      // capability isolation, and it only holds if the tools are ABSENT rather
      // than present-and-refused. A model that can see a tool will try it, and
      // "denied" is a poor way to learn a boundary (docs/TOOLS.md §4.3).
      expect(yield* visible("GeoAgent")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("plan sees the same four, because a planner must know what it will be able to do", () =>
    Effect.gen(function* () {
      // Upstream's plan keeps its edit tools in view — a tool vanishes only
      // when the last rule matching it is a wildcard deny, and plan's edit
      // rules end in a narrow allow. The same shape gives plan `qgis` and
      // `gee` as `ask`: present, and gated at the moment of use.
      expect(yield* visible("plan")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("explore sees reading, and only reading", () =>
    Effect.gen(function* () {
      /* Upstream's read-only search subagent, kept rather than disabled, and
       * given exactly one geographic tool.
       *
       * The point of the one is that surveying a folder of datasets — open
       * each, report its CRS, extent and fields — is a context-heavy opening
       * move in geographic work, and this is the agent that carries such work
       * in somebody else's context window (grep.txt, glob.txt and the overflow
       * hint in tool/truncate.ts all route to it).
       *
       * The point of the ONLY one is that surveying is reading. `qgis`, `gee`
       * and `osm` stay on the global deny, so nothing this agent does can
       * change the data it is describing. */
      expect(yield* visible("explore")).toEqual(["ReadGeoData"])
    }),
  )

  it.instance("an agent that denies everything sees none of them", () =>
    Effect.gen(function* () {
      // `summary` carries its own `"*": "deny"` — the same shape the osmfetch
      // subagent uses.
      //
      // Worth being exact about what this does NOT prove. A wildcard deny
      // matches any tool id directly, so it hides these eight whether or not
      // the id-to-key table has an entry for them. The table is what a
      // GROUP-level rule needs, and no agent in the line-up writes one that
      // reaches here — so it is pinned separately, below.
      expect(yield* visible("summary")).toEqual([])
    }),
  )
})

/* The keys below can only be observed from an ask, and every geographic tool
 * checks its environment BEFORE it raises one (docs/TOOLS.md §4.3) — so a
 * machine with nothing installed reaches no ask at all. Both environments are
 * handed over ready; what is under test here is the permission model, not the
 * kernel's readiness logic.
 */
describe("the keys the tools actually ask with", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoStatus.node, statusHolding({ qgis: QGIS_READY, gee: GEE_READY })],
    ]),
  )

  /* The half a config file cannot state.
   *
   * Every rule above is written against a key. Which key a tool ASKS with is
   * decided in its own source, and if the two drift there is no error: the
   * unmatched key falls through to the engine's default `"*": "allow"` and the
   * tool is quietly permitted for everyone — the rule is written, the rule is
   * correct, the rule is never consulted.
   *
   * So the keys are read off the live calls. The ask is made to fail the
   * instant it is recorded, which is also what keeps this test off the network
   * and off the disk: nothing runs past the permission check.
   */
  const GROUPS: Record<(typeof GEO_TOOLS)[number], { key: string; params: Record<string, unknown> }> = {
    ReadGeoData: { key: "geodata", params: { filePath: "/tmp/nothing.tif" } },
    QgisDoc: { key: "qgis", params: { action: "list_groups" } },
    RunQgisAlgorithm: { key: "qgis", params: { algorithm: "native:buffer", parameters: "{}" } },
    RunGeeScript: { key: "gee", params: { script: "print(1)" } },
    OsmSearch: { key: "osm", params: { query: "wuhan" } },
    OsmProbe: { key: "osm", params: { extents: ["bbox:30,114,31,115"], tags: ["amenity"] } },
    OsmGetObjects: { key: "osm", params: { ids: ["R1"], output: "/tmp/x.geojson" } },
    OsmGetFeatures: {
      key: "osm",
      params: { extents: ["bbox:30,114,31,115"], tags: ["amenity"], output: "/tmp/x.geojson" },
    },
  }

  for (const tool of GEO_TOOLS) {
    it.instance(`${tool} asks under "${GROUPS[tool].key}"`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const def = (yield* registry.all()).find((item) => item.id === tool)
        expect(def).toBeDefined()

        // Every key the call asks for, in order. A path outside the working
        // directory draws an `external_directory` ask first — upstream's, not
        // ours — so that one is waved through and the geographic ask is the one
        // that stops execution.
        const asked: string[] = []
        yield* def!
          .execute(GROUPS[tool].params, {
            sessionID: SessionID.make("ses_keys"),
            messageID: MessageID.make("msg_keys"),
            agent: "GeoAgent",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (req: any) => {
              asked.push(req.permission)
              return req.permission === "external_directory" ? Effect.void : Effect.fail(new Error("recorded"))
            },
          } as any)
          .pipe(Effect.exit)

        expect(asked).toContain(GROUPS[tool].key)
      }),
    )
  }
})

/* The table that joins the two halves above, pinned on its own.
 *
 * Everything before this asserts an AGENT, and no agent in the line-up reaches
 * the table: the ones holding geographic grants end in an allow or an ask, and
 * the ones holding none carry `"*": "deny"`, which matches a tool id directly
 * whether or not the table has an entry for it. Delete a row from GEO and every
 * assertion above still passes.
 *
 * The ruleset below is where a row actually matters, and it is not a synthetic
 * shape: it is what a user-defined agent gets. agent.ts builds one from
 * `merge(defaults, user)` — the engine's `"*": "allow"`, then the geographic
 * denies, which arrive through the user layer because the assembly layer merges
 * first. Such an agent is closed to the geographic tools only if the table
 * carries the rule from the group name to the ids.
 *
 * Upstream pins its own `edits` table exactly this way — a default allow plus
 * one group-level deny, asserted per tool id (test/permission/next.test.ts,
 * "disabled - disables edit/write/apply_patch when edit denied"). This is the
 * same test for the third table.
 */
describe("a rule written against a group reaches every tool in it", () => {
  const MEMBERS: Record<string, readonly string[]> = {
    geodata: ["ReadGeoData"],
    qgis: ["QgisDoc", "RunQgisAlgorithm"],
    osm: ["OsmSearch", "OsmProbe", "OsmGetObjects", "OsmGetFeatures"],
    gee: ["RunGeeScript"],
  }

  for (const [group, members] of Object.entries(MEMBERS)) {
    test(`"${group}": "deny" hides ${members.join(", ")}, and only those`, () => {
      const hidden = Permission.disabled(
        [...GEO_TOOLS],
        [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: group, pattern: "*", action: "deny" },
        ],
      )
      // Compared as a whole set rather than membership by membership: with
      // eight ids mapped onto four groups, asking only "are my four hidden"
      // would pass a row filed under the wrong group.
      expect([...hidden].sort()).toEqual([...members].sort())
    })
  }
})

describe("what each agent can do", () => {
  it.instance("GeoAgent works, and does not download", () =>
    Effect.gen(function* () {
      expect(yield* verdict("GeoAgent", "geodata")).toBe("allow")
      expect(yield* verdict("GeoAgent", "osm")).toBe("deny")

      /* Both executing groups ask, for reasons that do not transfer between
       * them — which is why the prompts they raise are shaped differently
       * (cli/cmd/run/permission.shared.ts).
       *
       * `qgis` is asked because the call can be READ and judged. `gee` is asked
       * because it CANNOT: a script is arbitrary Python and its output path
       * lives inside a string literal, so what the user grants is the
       * capability — credentials, quota, and imagery landing somewhere on their
       * disk — rather than any particular operation. */
      expect(yield* verdict("GeoAgent", "gee")).toBe("ask")

      /* `qgis` is the one group GeoCode asks about, and the only place it is
       * stricter than upstream is with its own tools.
       *
       * Not a leftover from plan mode: running an algorithm is the one thing
       * this product does that undo cannot reach (geographic data is outside
       * the checkpoint mechanism), and numbering only protects the outputs
       * `QgisDestination.reserve` can see — 56 of 422 algorithms in a real 3.44
       * registry declare no destination parameter at all. Flipping this back to
       * a plain "allow" removes the last thing standing between the model and
       * an in-place overwrite of the user's data. */
      expect(yield* verdict("GeoAgent", "qgis", "native:buffer(INPUT=/data/a.shp, OUTPUT=/data/b.shp)")).toBe("ask")
      // And looking something up never interrupts, at any time. A prompt for
      // reading documentation is a prompt that teaches the user to dismiss
      // prompts, which costs exactly the one above.
      expect(yield* verdict("GeoAgent", "qgis", "doc:search:buffer")).toBe("allow")
    }),
  )

  it.instance("plan reads freely, looks things up freely, and is asked before it acts", () =>
    Effect.gen(function* () {
      // Reading data and reading documentation are how a plan gets written;
      // neither may interrupt. Running an algorithm or a script changes the
      // world, and plan mode's whole premise is that the user does not want
      // that yet — so it is asked, not silently refused and not silently done.
      expect(yield* verdict("plan", "geodata")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "doc:list_groups")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "native:buffer")).toBe("ask")
      expect(yield* verdict("plan", "gee")).toBe("ask")
      expect(yield* verdict("plan", "osm")).toBe("deny")
    }),
  )

  it.instance("the `doc:` namespace is what separates looking up from running", () =>
    Effect.gen(function* () {
      // QgisDoc and RunQgisAlgorithm share one key, so the pattern is the only
      // thing telling them apart. If QgisDoc stopped prefixing its patterns,
      // `doc:*` would match nothing and consulting documentation would start
      // prompting the user mid-plan.
      for (const action of ["doc:list_groups", "doc:search:buffer", "doc:read:native:buffer"]) {
        expect(yield* verdict("plan", "qgis", action)).toBe("allow")
      }
      // And nothing that is not a documentation lookup slips through it.
      for (const algorithm of ["native:buffer", "gdal:warp", "qgis:clip"]) {
        expect(yield* verdict("plan", "qgis", algorithm)).toBe("ask")
      }
    }),
  )

  it.instance("the four denies are what close the engine's default allow", () =>
    Effect.gen(function* () {
      // Every agent starts from `"*": "allow"`, so a geographic key with no
      // rule of its own is not "unset" — it is GRANTED. The denies in the
      // assembly layer are the only thing standing between that default and a
      // capability nobody asked to hand out.
      //
      // Asserted against a synthetic default-allow ruleset rather than through
      // an existing agent, because every agent that holds no geographic grant
      // today (`summary`, `title`) also carries its own `"*": "deny"` — they
      // would answer "deny" whether our rules were there or not, and prove
      // nothing about them.
      const closed = Permission.merge(
        Permission.fromConfig({ "*": "allow" }),
        Permission.fromConfig((GeoCodeConfig.base().permission ?? {}) as Record<string, "deny">),
      )
      for (const key of ["geodata", "qgis", "osm", "gee"]) {
        expect(Permission.evaluate(key, "*", closed).action).toBe("deny")
      }
    }),
  )
})

describe("the subagent line-up", () => {
  it.instance("explore may read geographic data, and may not act on it", () =>
    Effect.gen(function* () {
      expect(yield* verdict("explore", "geodata")).toBe("allow")
      // One line in the assembly layer opens `geodata`; these three are what it
      // deliberately leaves shut. They are not restated there — they hold
      // because the global denies do, so this is the assertion that would catch
      // a later `"*": "allow"` slipping into this agent.
      expect(yield* verdict("explore", "qgis")).toBe("deny")
      expect(yield* verdict("explore", "gee")).toBe("deny")
      expect(yield* verdict("explore", "osm")).toBe("deny")
    }),
  )

  it.instance("and GeoAgent can actually reach it", () =>
    Effect.gen(function* () {
      /* The two conditions ToolRegistry.describeTask applies before a subagent
       * is named to the model (tool/registry.ts): not primary, and the caller's
       * `task` rule does not deny it.
       *
       * Both have to hold or the agent exists and the model never hears of it
       * — which is precisely what disabling it cost: `grep.txt`, `glob.txt` and
       * the overflow hint kept telling the model to delegate, at a list with
       * one OSM downloader on it.
       *
       * ⚠️ What this does NOT cover, despite reading like it does: whether the
       * assembly layer still ships `explore` at all. test/preload.ts writes
       * `explore: { disable: false }` into the test config, and user config
       * merges AFTER the assembly layer — so the agent is present here however
       * geocode.ts is written, and `toBeDefined` below can never fail for that
       * reason. Re-disabling it is caught by the source scan in
       * core/test/geocode-brand.test.ts. Measured, not assumed: flipping the
       * assembly layer back to `disable: true` turns that scan red and leaves
       * this test green. */
      const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
      expect(explore).toBeDefined()
      expect(explore!.mode).not.toBe("primary")

      const geo = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      expect(Permission.evaluate("task", "explore", geo!.permission).action).not.toBe("deny")
    }),
  )
})

describe("the user still owns their own machine", () => {
  it.instance("the geographic denies are defaults, not a layer the user cannot reach", () =>
    Effect.gen(function* () {
      // Upstream places the user's own rules LAST for every agent, so findLast
      // lets them override anything — including plan's edit lock. GeoCode's
      // geographic denies are merged FIRST, which gives them the same standing
      // as upstream's own defaults rather than inventing an enforced layer
      // upstream has no equivalent of (docs/KERNEL.md §5).
      //
      // Asserted through the engine rather than by reading the config: what
      // matters is that a later rule wins, which is the property a user's
      // config relies on.
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const overridden = Permission.merge(agent!.permission, Permission.fromConfig({ osm: "allow" }))
      expect(Permission.evaluate("osm", "*", overridden).action).toBe("allow")
    }),
  )
})

describe("what the prompt actually says", () => {
  /* The other half of a permission decision, and the half that has no engine
   * behind it: a verdict of `ask` is only worth what the dialog shows.
   *
   * Kept in this file rather than beside the CLI's own tests because the two
   * halves fail together. Flip `gee` back to `allow` and the rendering below is
   * dead code; delete the rendering and the `ask` verdicts above become dialogs
   * reading "Call tool gee" with nothing in them. Neither shows up in the other
   * file.
   *
   * `permissionInfo` is a pure function, so no instance is needed — hence plain
   * `test` here rather than the `it.instance` used above.
   */
  const request = (permission: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
    id: "perm-geo",
    sessionID: "ses-geo",
    permission,
    patterns: [],
    metadata: {},
    always: ["*"],
    ...extra,
  })

  test("none of the four keys falls through to the generic dialog", () => {
    /* The tripwire that matters most, because the fallback is SILENT: a key
     * that is not recognised still renders, still offers Allow/Reject, and
     * still looks like a working prompt — it just contains nothing to judge.
     * Upstream's table (`tool.ts`'s TOOL_RULES) is keyed by tool NAME, so none
     * of these four can ever be registered there, and any refactor that routes
     * them back through it lands exactly here. */
    for (const key of ["geodata", "qgis", "osm", "gee"]) {
      const info = permissionInfo(request(key, { patterns: ["x"], metadata: { algorithm: "native:buffer" } }))
      expect(info.title).not.toBe(`Call tool ${key}`)
      expect(info.lines).not.toEqual([`Tool: ${key}`])
    }
  })

  test("an algorithm call is spelled out, parameter by parameter", () => {
    // What the user is asked to judge is whether a path sits outside their
    // work — so the path has to survive into the dialog, absolute and whole.
    const info = permissionInfo(
      request("qgis", {
        patterns: ["native:buffer(INPUT=/data/a.shp, OUTPUT=/tmp/out.shp)"],
        metadata: { algorithm: "native:buffer", parameters: { INPUT: "/data/a.shp", OUTPUT: "/tmp/out.shp" } },
      }),
    )
    expect(info.title).toContain("native:buffer")
    expect(info.lines.join("\n")).toContain("/data/a.shp")
    expect(info.lines.join("\n")).toContain("/tmp/out.shp")
  })

  test("the two tools sharing the qgis key get two different dialogs", () => {
    /* One key, two tools — and a user who narrows it by hand (`"qgis": "ask"`
     * on an agent of their own) gets asked by both. If the dialogs were
     * interchangeable, the user would be approving "qgis" without knowing
     * whether this one reads documentation or runs something that writes.
     *
     * The reading dialog also must not leak the pattern syntax: `doc:` is a
     * namespace we invented for rule matching, and showing it asks the user to
     * parse our internals. */
    const doc = permissionInfo(
      request("qgis", { patterns: ["doc:read:native:buffer"], metadata: { action: "read", target: "native:buffer" } }),
    )
    const run = permissionInfo(
      request("qgis", { patterns: ["native:buffer(…)"], metadata: { algorithm: "native:buffer", parameters: {} } }),
    )
    expect(doc.title).not.toBe(run.title)
    expect(doc.title).toMatch(/documentation/i)
    // The reading dialog stays at the title. WHICH algorithm is being looked up
    // changes nothing a user decides — it is read-only either way — so spending
    // a line on it spends attention the dialog below actually needs.
    expect(doc.lines.join("\n")).not.toContain("native:buffer")
    // And never the raw pattern, which is a rule-matching string, not English.
    expect(doc.lines.join("\n")).not.toContain("doc:")
    // The running dialog is the opposite: it has to name what it will run.
    expect(`${run.title}\n${run.lines.join("\n")}`).toContain("native:buffer")
  })

  test("reading geographic data looks like upstream reading a file", () => {
    /* `ReadGeoData` aligns with upstream's `read`, and the alignment is already
     * exact on the input side — both ask with
     * `path.relative(instance.worktree, filepath)` and `always: ["*"]`. Since
     * the two dialogs are handed the same shape of data, a user who has learned
     * one should not have to learn the other.
     *
     * The part worth pinning is `toolPath`: without it a file outside the
     * workspace renders as a run of `../`, which is a path the user has to do
     * arithmetic on. Asserted by comparing against the upstream dialog for the
     * same pattern rather than against a hardcoded string, so this keeps
     * holding if upstream changes how it abbreviates.
     */
    for (const pattern of ["data/scene.tif", "../../elsewhere/scene.tif"]) {
      const ours = permissionInfo(request("geodata", { patterns: [pattern] }))
      const theirs = permissionInfo(request("read", { patterns: [pattern] }))
      expect(ours.icon).toBe(theirs.icon)
      expect(ours.lines).toEqual(theirs.lines)
      // The abbreviated form upstream shows has to appear in ours too — and for
      // an outside path that is NOT the raw pattern.
      const shownByUpstream = theirs.lines.join("\n").replace("Path: ", "")
      expect(ours.title).toContain(shownByUpstream)
    }
  })

  test("a GEE script is NOT spelled out, and that is the design", () => {
    /* Deliberately asserting an absence. A script is arbitrary Python; folding
     * it into a dialog would produce something nobody reads, and a prompt that
     * is never read is worse than none — it manufactures the impression of
     * review. What is granted is the capability, so that is all the dialog
     * claims. A well-meaning change that starts printing the body lands here.
     */
    /* ⚠️ The body has to be PRESENT in the metadata for this to mean anything.
     * Written first with `metadata: { script: "" }`, it asserted that something
     * never supplied did not appear — green forever, and green for the wrong
     * reason (LESSONS §二①). The tool does not put the body there today, but a
     * dialog that would print it if it were there is exactly the regression
     * worth catching, and the observability fix that adds it must not silently
     * turn this prompt into a wall of Python. */
    const body = "import ee\ndownload_image(image, '/data/scene.tif', roi)"
    const info = permissionInfo(
      request("gee", {
        patterns: ["/Users/me/secret-pipeline.py"],
        metadata: { script: "/Users/me/secret-pipeline.py", source: body },
      }),
    )
    const shown = `${info.title}\n${info.lines.join("\n")}`
    expect(info.title).toMatch(/earth engine/i)
    // Not the body — nobody reads Python in a dialog.
    expect(shown).not.toContain("download_image")
    // And not the path either. Showing it suggests the user is judging THIS
    // script, when all they can actually judge is whether Earth Engine may run
    // at all. A detail that invites a judgement the user cannot make is worse
    // than no detail.
    expect(shown).not.toContain("secret-pipeline")
  })
})
