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

/* The geographic permission model, both layers (docs/TOOLS.md §4): visibility by TOOL ID in Permission.disabled,
 * execution by the key the tool declares in `ctx.ask` in Permission.evaluate. GeoCode's ids and keys diverge, a
 * table in permission/index.ts joins them, and a missing row there raises nothing — so neither layer is inferred
 * from the other here, and the table is pinned on its own below. */

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

/** Whether this agent is offered the tool at all: only a wildcard deny takes it off the list. */
const offered = Effect.fnUntraced(function* (name: string, tool: string) {
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  expect(agent).toBeDefined()
  return !Permission.disabled([tool], agent!.permission).has(tool)
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
      // Routing downloads through the osmfetch subagent only isolates anything if the OSM tools are ABSENT
      // rather than present-and-refused: a model that can see a tool will try it (docs/TOOLS.md §4.3).
      expect(yield* visible("GeoAgent")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("plan sees the same four, because a planner must know what it will be able to do", () =>
    Effect.gen(function* () {
      // A tool vanishes only when the last rule matching it is a wildcard deny, so plan's `qgis` and `gee` asks
      // leave the tools present and gated at the moment of use, the shape that keeps its edit tools in view too.
      expect(yield* visible("plan")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("an agent that denies everything sees none of them", () =>
    Effect.gen(function* () {
      // `summary` carries its own `"*": "deny"`, which matches a tool id directly and so hides these eight
      // whether or not the id-to-key table has a row for them — the table is pinned separately, below.
      expect(yield* visible("summary")).toEqual([])
    }),
  )
})

/* The lineup as the desktop shell presents it, checked here because this is where the Agent service is already
 * booted. `native` changes nothing in the kernel — one sort in `opencode agent list` reads it and nothing else —
 * but the shell files a non-native agent under "custom", badges it with its config scope instead of "system",
 * and offers Rename and Delete on it rather than Reset. GeoAgent and osmfetch reach the table through
 * `cfg.agent`, whose default is `native: false`, so `config/geocode.ts` names them and nothing but this notices
 * when that wiring goes. */
describe("which agents the product ships", () => {
  it.instance("marks GeoCode's own agents native, the way upstream marks its built-ins", () =>
    Effect.gen(function* () {
      for (const name of ["GeoAgent", "osmfetch", "plan", "explore"]) {
        const agent = yield* Agent.Service.use((svc) => svc.get(name))
        expect([name, agent?.native]).toEqual([name, true])
      }
    }),
  )
})

/* Both environments are handed over ready because every geographic tool checks its own before it raises an ask
 * (docs/TOOLS.md §4.3), so on a machine with nothing installed there is no key to observe. */
describe("the keys the tools actually ask with", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoStatus.node, statusHolding({ qgis: QGIS_READY, gee: GEE_READY })],
    ]),
  )

  /* Which key a tool ASKS with is decided in its own source, and a drift from the rules above raises nothing:
   * the unmatched key falls through to the engine's `"*": "allow"` and the tool is quietly permitted for
   * everyone. So the keys are read off live calls, and the ask fails the instant one is recorded. */
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

        // Every key the call asks for, in order. A path outside the working directory draws upstream's
        // `external_directory` ask first, so that one is waved through and the geographic ask is what stops it.
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

/* Delete a row from permission/index.ts's GEO table and every assertion above still passes: no agent in the
 * line-up reaches it, since the ones holding geographic grants end in an allow or an ask and the ones holding
 * none carry `"*": "deny"`, which matches a tool id directly. The ruleset below is what a user-defined agent
 * gets — `merge(defaults, user)`, the engine's `"*": "allow"` plus the geographic denies arriving through the
 * user layer — and it closes only if the table carries the group name onto the ids, the way upstream pins
 * `edits` in test/permission/next.test.ts. */
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
      // Compared as a whole set: with eight ids over four groups, asking only "are my four hidden" would pass a
      // row filed under the wrong group.
      expect([...hidden].sort()).toEqual([...members].sort())
    })
  }
})

describe("what each agent can do", () => {
  it.instance("GeoAgent works, and does not download", () =>
    Effect.gen(function* () {
      expect(yield* verdict("GeoAgent", "geodata")).toBe("allow")
      expect(yield* verdict("GeoAgent", "osm")).toBe("deny")

      // Both executing groups ask, but for reasons that do not transfer: a `qgis` call can be read and judged, a
      // GEE script cannot, so what `gee` grants is the capability rather than any particular operation.
      expect(yield* verdict("GeoAgent", "gee")).toBe("ask")

      // Running an algorithm is the one thing this product does that undo cannot reach, and numbering only
      // protects the outputs `QgisDestination.reserve` can recognise, so a plain allow here would leave nothing
      // between the model and an in-place overwrite of the user's data.
      expect(yield* verdict("GeoAgent", "qgis", "native:buffer(INPUT=/data/a.shp, OUTPUT=/data/b.shp)")).toBe("ask")
      // And looking something up never interrupts: a prompt for reading documentation teaches the user to
      // dismiss prompts, which costs exactly the one above.
      expect(yield* verdict("GeoAgent", "qgis", "doc:search:buffer")).toBe("allow")
    }),
  )

  it.instance("plan reads freely, looks things up freely, and is asked before it acts", () =>
    Effect.gen(function* () {
      // The executing groups stay askable so plan keeps seeing them (config/geocode.ts); `osm` is the one
      // denied outright.
      expect(yield* verdict("plan", "geodata")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "doc:list_groups")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "native:buffer")).toBe("ask")
      expect(yield* verdict("plan", "gee")).toBe("ask")
      expect(yield* verdict("plan", "osm")).toBe("deny")
    }),
  )

  it.instance("the `doc:` namespace is what separates looking up from running", () =>
    Effect.gen(function* () {
      // QgisDoc and RunQgisAlgorithm share one key, so the pattern is all that tells them apart: stop prefixing
      // and `doc:*` matches nothing, at which point consulting documentation starts prompting mid-plan.
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
      // Every agent starts from `"*": "allow"`, so a geographic key with no rule of its own is GRANTED rather
      // than unset. Asserted against a synthetic default-allow ruleset because every agent holding no
      // geographic grant today also carries its own `"*": "deny"` and would answer "deny" without ours.
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

describe("the user still owns their own machine", () => {
  it.instance("the geographic denies are defaults, not a layer the user cannot reach", () =>
    Effect.gen(function* () {
      // The geographic denies are merged FIRST, so `findLast` still lets a later rule win — the same standing as
      // upstream's own defaults, rather than an enforced layer upstream has no equivalent of (docs/KERNEL.md §5).
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const overridden = Permission.merge(agent!.permission, Permission.fromConfig({ osm: "allow" }))
      expect(Permission.evaluate("osm", "*", overridden).action).toBe("allow")
    }),
  )
})

describe("what the prompt actually says", () => {
  /* The half of a permission decision with no engine behind it: an `ask` verdict is worth what the dialog shows.
   * Kept beside the verdicts because the two fail together — flip `gee` back to `allow` and the rendering below
   * is dead code, delete the rendering and the `ask` verdicts above become dialogs reading "Call tool gee".
   * `permissionInfo` is pure, hence plain `test` rather than the `it.instance` above. */
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
    /* The fallback is SILENT: an unrecognised key still renders, still offers Allow/Reject and still looks like
     * a working prompt, with nothing in it to judge. `tool.ts`'s TOOL_RULES is keyed by tool NAME, so none of
     * these four can be registered there, and a refactor routing them back through it lands here. */
    for (const key of ["geodata", "qgis", "osm", "gee"]) {
      const info = permissionInfo(request(key, { patterns: ["x"], metadata: { algorithm: "native:buffer" } }))
      expect(info.title).not.toBe(`Call tool ${key}`)
      expect(info.lines).not.toEqual([`Tool: ${key}`])
    }
  })

  test("an algorithm call is spelled out, parameter by parameter", () => {
    // What the user judges is whether a path sits outside their work, so it has to reach the dialog whole.
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
    /* A user who narrows the key by hand (`"qgis": "ask"` on an agent of their own) gets asked by both tools, so
     * interchangeable dialogs would have them approving "qgis" without knowing whether this one reads
     * documentation or runs something that writes. */
    const doc = permissionInfo(
      request("qgis", { patterns: ["doc:read:native:buffer"], metadata: { action: "read", target: "native:buffer" } }),
    )
    const run = permissionInfo(
      request("qgis", { patterns: ["native:buffer(…)"], metadata: { algorithm: "native:buffer", parameters: {} } }),
    )
    expect(doc.title).not.toBe(run.title)
    expect(doc.title).toMatch(/documentation/i)
    // The reading dialog stays at the title: which algorithm is looked up changes nothing a user decides, so a
    // line spent on it is attention the running dialog needs.
    expect(doc.lines.join("\n")).not.toContain("native:buffer")
    // And never the raw pattern, which is a rule-matching string, not English.
    expect(doc.lines.join("\n")).not.toContain("doc:")
    // The running dialog is the opposite: it has to name what it will run.
    expect(`${run.title}\n${run.lines.join("\n")}`).toContain("native:buffer")
  })

  test("reading geographic data looks like upstream reading a file", () => {
    /* `ReadGeoData` asks with the same shape upstream's `read` does — `path.relative(worktree, filepath)` and
     * `always: ["*"]` — so the two dialogs are handed the same data and have no reason to differ. What is
     * really pinned is `toolPath`: without it a file outside the workspace renders as a run of `../`. Compared
     * against the upstream dialog rather than a hardcoded string, so it survives a change to how it abbreviates. */
    for (const pattern of ["data/scene.tif", "../../elsewhere/scene.tif"]) {
      const ours = permissionInfo(request("geodata", { patterns: [pattern] }))
      const theirs = permissionInfo(request("read", { patterns: [pattern] }))
      expect(ours.icon).toBe(theirs.icon)
      expect(ours.lines).toEqual(theirs.lines)
      // The abbreviated form upstream shows has to appear in ours, and for an outside path it is not the pattern.
      const shownByUpstream = theirs.lines.join("\n").replace("Path: ", "")
      expect(ours.title).toContain(shownByUpstream)
    }
  })

  test("a GEE script is NOT spelled out, and that is the design", () => {
    /* An absence, so the body has to be PRESENT in the metadata for the assertion to mean anything — against a
     * fixture that never supplied one it would be green forever and green for the wrong reason. geo-gee-run.ts
     * sends only `{ script: <path> }` today; what is caught is a dialog that would print a body if one arrived. */
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
    // And not the path either: showing it suggests the user is judging THIS script, when all they can judge is
    // whether Earth Engine may run at all.
    expect(shown).not.toContain("secret-pipeline")
  })
})

/* The browser tool comes from a plugin rather than the registry, so it is absent from GEO_TOOLS and needs its
 * own reading of both questions: who may drive it, and who is offered it at all. GeoAgent and plan may; for the
 * rest the global deny is what keeps it off the list, since `Permission.disabled` acts on a wildcard deny alone
 * (session/llm/request.ts filters every tool through it). Docs/DESKTOP.md §7.2. */
describe("the browser tool's verdicts", () => {
  it.instance("GeoAgent and plan may drive it, acting included", () =>
    Effect.gen(function* () {
      const acting = ["browser.open", "browser.snapshot", "browser.scroll", "browser.inspect", "browser.capture", "browser.click", "browser.type"]
      for (const agent of ["GeoAgent", "plan"]) {
        for (const pattern of acting) {
          expect([agent, pattern, yield* verdict(agent, "browser", pattern)]).toEqual([agent, pattern, "allow"])
        }
      }
    }),
  )

  it.instance("no other agent has it, and the deny hides it rather than failing at the call", () =>
    Effect.gen(function* () {
      for (const agent of ["osmfetch", "summary", "explore"]) {
        expect([agent, yield* verdict(agent, "browser", "browser.open")]).toEqual([agent, "deny"])
        expect([agent, yield* offered(agent, "browser")]).toEqual([agent, false])
      }
      for (const agent of ["GeoAgent", "plan"]) {
        expect([agent, yield* offered(agent, "browser")]).toEqual([agent, true])
      }
    }),
  )
})
