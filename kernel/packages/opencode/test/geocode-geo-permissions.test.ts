import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoCodeConfig } from "../src/config/geocode"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { MessageID, SessionID } from "../src/session/schema"
import { GeoKernel } from "../src/geo"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

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
 * written, it is simply never consulted. That is the failure KERNEL.md §4.1
 * records from the old build, and the reason both layers are asserted here
 * rather than one being inferred from the other.
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

  it.instance("an agent that denies everything sees none of them", () =>
    Effect.gen(function* () {
      // `summary` carries its own `"*": "deny"` — the same shape the osmfetch
      // subagent will use. A wildcard deny only reaches a geographic tool
      // through the id-to-key table: drop an entry there and that tool's id
      // stops matching anything, falls through to no rule at all, and
      // reappears in the list of an agent meant to hold nothing.
      expect(yield* visible("summary")).toEqual([])
    }),
  )
})

describe("the keys the tools actually ask with", () => {
  /* The half a config file cannot state.
   *
   * Every rule above is written against a key. Which key a tool ASKS with is
   * decided in its own source, and if the two drift there is no error: the
   * unmatched key falls through to the engine's default `"*": "allow"` and the
   * tool is quietly permitted for everyone. That is the old build's accident
   * (docs/KERNEL.md §4.1) in its purest form — the rule is written, the rule
   * is correct, the rule is never consulted.
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

describe("what each agent can do", () => {
  it.instance("GeoAgent works, and does not download", () =>
    Effect.gen(function* () {
      expect(yield* verdict("GeoAgent", "geodata")).toBe("allow")
      expect(yield* verdict("GeoAgent", "qgis")).toBe("allow")
      expect(yield* verdict("GeoAgent", "gee")).toBe("allow")
      expect(yield* verdict("GeoAgent", "osm")).toBe("deny")
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
