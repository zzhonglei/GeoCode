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

// Visibility goes by tool id and execution by permission key, joined by a table in permission/index.ts where a
// missing row raises nothing, so each layer is checked on its own (docs/TOOLS.md §4).

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

const visible = Effect.fnUntraced(function* (name: string) {
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  expect(agent).toBeDefined()
  const hidden = Permission.disabled([...GEO_TOOLS], agent!.permission)
  return GEO_TOOLS.filter((tool) => !hidden.has(tool))
})

/** Only a wildcard deny takes a tool off the list. */
const offered = Effect.fnUntraced(function* (name: string, tool: string) {
  const agent = yield* Agent.Service.use((svc) => svc.get(name))
  expect(agent).toBeDefined()
  return !Permission.disabled([tool], agent!.permission).has(tool)
})

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
      // Absent rather than present and refused, because a model that can see a tool will try it.
      expect(yield* visible("GeoAgent")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("plan sees the same four, because a planner must know what it will be able to do", () =>
    Effect.gen(function* () {
      expect(yield* visible("plan")).toEqual(["ReadGeoData", "QgisDoc", "RunQgisAlgorithm", "RunGeeScript"])
    }),
  )

  it.instance("an agent that denies everything sees none of them", () =>
    Effect.gen(function* () {
      // summary's own "*": "deny" hides these whether or not the id-to-key table has rows, so this does not pin it.
      expect(yield* visible("summary")).toEqual([])
    }),
  )
})

// Without this, agents built from cfg.agent are not native, and the desktop shell files them as the user's own.
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

describe("the keys the tools actually ask with", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoStatus.node, statusHolding({ qgis: QGIS_READY, gee: GEE_READY })],
    ]),
  )

  // A key that drifts from the rules falls through to the engine's "*": "allow", permitting the tool for everyone.
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

        // A path outside the worktree draws upstream's external_directory ask first, so that one is waved through.
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

// No shipped agent notices a row missing from permission/index.ts's GEO table; a user-defined agent's ruleset, the
// engine's "*": "allow" plus a group deny, does.
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
      // The whole set, or a row filed under the wrong group would pass.
      expect([...hidden].sort()).toEqual([...members].sort())
    })
  }
})

describe("what each agent can do", () => {
  it.instance("GeoAgent works, and does not download", () =>
    Effect.gen(function* () {
      expect(yield* verdict("GeoAgent", "geodata")).toBe("allow")
      expect(yield* verdict("GeoAgent", "osm")).toBe("deny")

      expect(yield* verdict("GeoAgent", "gee")).toBe("ask")

      // QgisDestination.reserve protects only the outputs it recognises, so an allow here would leave nothing
      // between the model and an in-place overwrite of the user's data.
      expect(yield* verdict("GeoAgent", "qgis", "native:buffer(INPUT=/data/a.shp, OUTPUT=/data/b.shp)")).toBe("ask")
      // A prompt for reading documentation teaches the user to dismiss the one above.
      expect(yield* verdict("GeoAgent", "qgis", "doc:search:buffer")).toBe("allow")
    }),
  )

  it.instance("plan reads freely, looks things up freely, and is asked before it acts", () =>
    Effect.gen(function* () {
      expect(yield* verdict("plan", "geodata")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "doc:list_groups")).toBe("allow")
      expect(yield* verdict("plan", "qgis", "native:buffer")).toBe("ask")
      expect(yield* verdict("plan", "gee")).toBe("ask")
      expect(yield* verdict("plan", "osm")).toBe("deny")
    }),
  )

  it.instance("the `doc:` namespace is what separates looking up from running", () =>
    Effect.gen(function* () {
      // QgisDoc and RunQgisAlgorithm share one key, so without the doc: prefix every documentation lookup prompts.
      for (const action of ["doc:list_groups", "doc:search:buffer", "doc:read:native:buffer"]) {
        expect(yield* verdict("plan", "qgis", action)).toBe("allow")
      }
      for (const algorithm of ["native:buffer", "gdal:warp", "qgis:clip"]) {
        expect(yield* verdict("plan", "qgis", algorithm)).toBe("ask")
      }
    }),
  )

  it.instance("the four denies are what close the engine's default allow", () =>
    Effect.gen(function* () {
      // A synthetic default-allow ruleset, because every agent without geographic grants also denies "*" and
      // would answer deny without ours.
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
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const overridden = Permission.merge(agent!.permission, Permission.fromConfig({ osm: "allow" }))
      expect(Permission.evaluate("osm", "*", overridden).action).toBe("allow")
    }),
  )
})

describe("what the prompt actually says", () => {
  // An ask verdict is worth what the dialog shows, and without these renderings it reads "Call tool gee".
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
    // The generic dialog still offers Allow and Reject, so falling back to it fails silently.
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
    // A user who sets "qgis": "ask" is asked by both tools, and has to tell a lookup from a run that writes.
    const doc = permissionInfo(
      request("qgis", { patterns: ["doc:read:native:buffer"], metadata: { action: "read", target: "native:buffer" } }),
    )
    const run = permissionInfo(
      request("qgis", { patterns: ["native:buffer(…)"], metadata: { algorithm: "native:buffer", parameters: {} } }),
    )
    expect(doc.title).not.toBe(run.title)
    expect(doc.title).toMatch(/documentation/i)
    // Which algorithm is looked up changes nothing the user decides.
    expect(doc.lines.join("\n")).not.toContain("native:buffer")
    // And never the raw pattern, which is a rule-matching string, not English.
    expect(doc.lines.join("\n")).not.toContain("doc:")
    expect(`${run.title}\n${run.lines.join("\n")}`).toContain("native:buffer")
  })

  test("reading geographic data looks like upstream reading a file", () => {
    // Without toolPath a file outside the workspace renders as a run of ../.
    for (const pattern of ["data/scene.tif", "../../elsewhere/scene.tif"]) {
      const ours = permissionInfo(request("geodata", { patterns: [pattern] }))
      const theirs = permissionInfo(request("read", { patterns: [pattern] }))
      expect(ours.icon).toBe(theirs.icon)
      expect(ours.lines).toEqual(theirs.lines)
      const shownByUpstream = theirs.lines.join("\n").replace("Path: ", "")
      expect(ours.title).toContain(shownByUpstream)
    }
  })

  test("a GEE script is NOT spelled out, and that is the design", () => {
    // The fixture supplies a body, or the absence asserted below would pass for the wrong reason.
    const body = "import ee\ndownload_image(image, '/data/scene.tif', roi)"
    const info = permissionInfo(
      request("gee", {
        patterns: ["/Users/me/secret-pipeline.py"],
        metadata: { script: "/Users/me/secret-pipeline.py", source: body },
      }),
    )
    const shown = `${info.title}\n${info.lines.join("\n")}`
    expect(info.title).toMatch(/earth engine/i)
    expect(shown).not.toContain("download_image")
    // Nor the path: the user can judge only whether Earth Engine may run, not this script.
    expect(shown).not.toContain("secret-pipeline")
  })
})

// The browser tool comes from a plugin rather than the registry, so GEO_TOOLS does not cover it (docs/DESKTOP.md §7.2).
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

describe("the geocode tool's verdicts", () => {
  it.instance("GeoAgent may use every action, the writes included", () =>
    Effect.gen(function* () {
      const actions = ["projects.list", "session.create", "session.send", "session.fork", "schedule.create", "schedule.run", "schedule.delete"]
      for (const pattern of actions) {
        expect([pattern, yield* verdict("GeoAgent", "geocode", pattern)]).toEqual([pattern, "allow"])
      }
      expect(yield* offered("GeoAgent", "geocode")).toBe(true)
    }),
  )

  it.instance("no other agent has it, plan included, and the deny hides it rather than failing at the call", () =>
    Effect.gen(function* () {
      for (const agent of ["plan", "osmfetch", "summary", "explore"]) {
        expect([agent, yield* verdict(agent, "geocode", "session.create")]).toEqual([agent, "deny"])
        expect([agent, yield* offered(agent, "geocode")]).toEqual([agent, false])
      }
    }),
  )
})
