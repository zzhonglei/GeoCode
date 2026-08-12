import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoOsm } from "../src/geo"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import SEARCH_DESCRIPTION from "../src/tool/geo-osm-search.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

/* Tripwires for OsmSearch (docs/TOOLS.md §3; GEOKERNEL §6.2, §6.8).
 *
 * The OSM group has no environment, so there is no gate to test and no
 * guidance to render. What replaces those as the thing worth guarding is the
 * capability boundary — this group is reachable only through the osmfetch
 * subagent, never from GeoAgent directly — and one presentation rule: an
 * answer assembled from one engine instead of two must not read like a
 * complete one.
 */

const CANDIDATE = (over: Partial<GeoOsm.OsmSearch.Candidate> = {}): GeoOsm.OsmSearch.Candidate => ({
  type: "relation",
  id: 10717504,
  name: "武汉大学",
  className: "amenity",
  classValue: "university",
  center: { lat: 30.5395, lon: 114.3672 },
  importance: 0.5312,
  sources: new Set(["geocoder", "features"]),
  transit: false,
  ...over,
})

/** An OSM service under the test's control — no network, no endpoints. */
function osmService(result: Partial<GeoOsm.SearchResult>) {
  return Layer.mock(GeoOsm.Service)({
    search: () =>
      Effect.succeed({
        candidates: [],
        engines: { geocoder: 0, features: 0 },
        notes: [],
        ...result,
      }),
  })
}

const harness = (osm: Layer.Layer<GeoOsm.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoOsm.node, osm],
    ]),
  )

const execute = Effect.fnUntraced(function* (params: Record<string, unknown>, agentName = "GeoAgent") {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  const tool = (yield* registry.all()).find((item) => item.id === "OsmSearch")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_osm_test"),
      messageID: MessageID.make("msg_osm_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_osm_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(10_000), Effect.exit)
})

/**
 * Runs the tool with the boundary lifted.
 *
 * The OSM group is denied to every agent that exists today — that IS the
 * design (§4.3), and the test above pins it. Everything below is about what
 * the tool prints, which would otherwise be untestable until the subagent that
 * may call it lands.
 */
const succeed = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmSearch")
  expect(tool).toBeDefined()
  return yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_osm_test"),
    messageID: MessageID.make("msg_osm_test"),
    agent: "GeoAgent",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  })
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("OsmSearch, the capability boundary", () => {
  const it = harness(osmService({ candidates: [CANDIDATE()] }))

  it.instance(
    "is registered, and reachable by nobody yet",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("OsmSearch")

        // GeoAgent deliberately does NOT carry `geo_osm_*`: downloading from
        // public services goes through the osmfetch subagent, whose network exit
        // is locked. This is capability isolation, not an oversight — and until
        // that subagent lands, "denied" is the correct answer for everyone
        // (docs/TOOLS.md §4.3, KERNEL.md §5).
        for (const agent of ["GeoAgent", "plan"]) {
          const denied = yield* execute({ query: "武汉大学" }, agent)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
        }
      }),
    // Explicit budget: bun's per-test default is 5s, and building the registry
    // for a fresh instance crosses it on a loaded machine — the whole gate runs
    // in one process. A flaky red is worse than a slow green; it teaches people
    // to re-run instead of to read.
    { timeout: 20_000 },
  )
})

describe("OsmSearch, reading the answer", () => {
  harness(
    osmService({
      candidates: [
        CANDIDATE(),
        CANDIDATE({
          type: "way",
          id: 42,
          name: "武汉大学站",
          className: "railway",
          classValue: "station",
          sources: new Set(["features"]),
          transit: true,
          importance: undefined,
          center: undefined,
        }),
      ],
      engines: { geocoder: 3, features: 7 },
    }),
  ).instance(
    "a candidate line carries the id, the sources and the noise marker",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ query: "武汉大学" })
        // The id in the form the next tool takes it: R/W/N + number, which is
        // what OsmGetObjects wants and what "area:R<id>" is built from.
        expect(result.output).toContain("R10717504")
        expect(result.output).toContain("W42")
        expect(result.output).toContain("amenity=university")
        // Every source, not a "both" flag. The old build's description promised
        // "[both]" while its code printed the engine names — the code had it
        // right: with one source the name is a diagnosis, with two the count is
        // the confidence.
        expect(result.output).toContain("[geocoder+features]")
        expect(result.output).toContain("[features]")
        // Transit entries are usually noise in a place search and usually
        // outnumber the target; they are kept but marked (§6.8).
        expect(result.output).toContain("(transit)")
        expect(result.output).toContain("imp=0.531")
        expect(result.output).toContain("center=30.5395,114.3672")

        // Per engine, because the merge hides which one answered.
        expect(result.metadata.engines).toEqual({ geocoder: 3, features: 7 })
        expect(result.metadata.candidates).toBe(2)
        expect(result.metadata.degraded).toBeUndefined()
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      candidates: [CANDIDATE({ sources: new Set(["geocoder"]) })],
      engines: { geocoder: 4, features: 0 },
      notes: ["the feature service did not answer (timeout); these results are geocoded only"],
    }),
  ).instance(
    "half an answer says so, and still hands back what it has",
    () =>
      Effect.gen(function* () {
        // The two engines' recall sets differ a lot, so one of them silent is a
        // materially smaller answer — correct as far as it goes, and incomplete
        // in a way nothing about the candidate list would reveal.
        const result = yield* succeed({ query: "武汉大学" })
        expect(result.output).toContain("NOTE: the feature service did not answer")
        expect(result.output).toContain("R10717504")
        expect(result.metadata.degraded).toBe(true)
        // Notes come first: they describe the whole answer, and a reader who
        // meets them after the list has already read the list as complete.
        expect(result.output.indexOf("NOTE:")).toBeLessThan(result.output.indexOf("R10717504"))
      }),
    { timeout: 20_000 },
  )

  harness(osmService({ candidates: [], engines: { geocoder: 0, features: 0 } })).instance(
    "nothing found is an instruction, not a dead end",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ query: "asdfghjkl" })
        expect(result.output).toContain("No matches")
        // Every route onward the old build settled on, because "not found" with
        // no next move is where a model starts inventing ids.
        expect(result.output).toContain("abbreviations")
        expect(result.output).toContain("context")
        expect(result.output).toContain("name:en")
        expect(result.output).toContain("OsmProbe")
        expect(result.metadata.candidates).toBe(0)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmSearch, the description", () => {
  test("it warns about the wait, which is the one thing §11.2 found missing", () => {
    // The old build's copy said nothing about timing, and a model that reads a
    // normal failover as a hang will abandon the call and retry — paying the
    // same cost again, from the start.
    expect(SEARCH_DESCRIPTION).toContain("TIMING")
    expect(SEARCH_DESCRIPTION).toMatch(/do not abandon the call and retry/i)
  })

  test("it never teaches a bracket marker the code does not print", () => {
    // Where the old build drifted: the description taught `[both]`, which the
    // renderer never emitted.
    //
    // The markers are no longer enumerated. Choosing between candidates needs
    // "more sources, more confidence" — which lookup produced which name is a
    // fact about this tool's insides, and the model has no decision to make
    // with it. So the assertion is inverted: naming none is fine, naming one
    // the code does not print is not.
    const EMITTED = ["geocoder", "features", "site", "canonical"]
    for (const [, marker] of SEARCH_DESCRIPTION.matchAll(/\[([a-z]+)\]/g)) {
      expect(EMITTED).toContain(marker)
    }
    expect(SEARCH_DESCRIPTION).not.toContain("[both]")
  })
})
