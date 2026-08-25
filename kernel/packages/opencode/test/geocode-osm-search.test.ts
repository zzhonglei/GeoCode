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

/* Tripwires for OsmSearch (docs/TOOLS.md §3; GEOKERNEL §6.2, §6.8). With no environment there is no gate and no
 * guidance, leaving the capability boundary and one presentation rule: an answer assembled from one engine instead
 * of two must not read like a complete one. */

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

/** Runs the tool with the capability boundary lifted, since everything below is about what it prints. */
const succeed = Effect.fnUntraced(function* (
  params: Record<string, unknown>,
  abort: AbortSignal = AbortSignal.any([]),
) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmSearch")
  expect(tool).toBeDefined()
  return yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_osm_test"),
    messageID: MessageID.make("msg_osm_test"),
    agent: "GeoAgent",
    abort,
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

        // Neither ruleset carries `osm`: reaching the public services is osmfetch's alone, and the wildcard deny
        // above it keeps the four OSM tools out of these two agents' tool lists (docs/TOOLS.md §4.2 ①, §4.3).
        for (const agent of ["GeoAgent", "plan"]) {
          const denied = yield* execute({ query: "武汉大学" }, agent)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
        }
      }),
    // bun's 5s default is not enough to build a registry for a fresh instance on a machine running the whole gate.
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
        // The id in the form the next tool takes it: OsmGetObjects wants "R10717504", and "area:R<id>" is built
        // from the same prefix.
        expect(result.output).toContain("R10717504")
        expect(result.output).toContain("W42")
        expect(result.output).toContain("amenity=university")
        expect(result.output).toContain("[geocoder+features]")
        expect(result.output).toContain("[features]")
        // Transit hits are downweighted noise in a place search, kept but marked (§6.8).
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
        // One engine silent is a materially smaller answer, and nothing about the candidate list would reveal it.
        const result = yield* succeed({ query: "武汉大学" })
        expect(result.output).toContain("NOTE: the feature service did not answer")
        expect(result.output).toContain("R10717504")
        expect(result.metadata.degraded).toBe(true)
        // And before the list, which a reader who meets the note afterwards has already taken as complete.
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
        // "Not found" with no next move is where a model starts inventing ids.
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
  test("it warns about the wait, which is the one thing §11 found missing", () => {
    expect(SEARCH_DESCRIPTION).toContain("TIMING")
    expect(SEARCH_DESCRIPTION).toMatch(/do not abandon the call and retry/i)
  })

  test("it never teaches a bracket marker the code does not print", () => {
    // Inverted on purpose: the description need name no marker at all, but a marker it names has to be one
    // `formatCandidate` can print.
    const EMITTED = ["geocoder", "features", "site", "canonical"]
    for (const [, marker] of SEARCH_DESCRIPTION.matchAll(/\[([a-z]+)\]/g)) {
      expect(EMITTED).toContain(marker)
    }
    expect(SEARCH_DESCRIPTION).not.toContain("[both]")
  })
})

describe("OsmSearch, the two things it never said", () => {
  const it = harness(osmService({ candidates: [CANDIDATE()] }))

  it.instance(
    "an empty query is refused rather than sent",
    () =>
      Effect.gen(function* () {
        // A blank query is not a no-op but `rel["name"~""]`, which matches every named element on the planet.
        for (const query of ["", "   "]) {
          const result = yield* succeed({ query })
          expect(result.metadata.error_code).toBe("InvalidParameters")
          expect(result.metadata.failed).toBe(true)
          expect(result.output).toContain("empty")
        }
      }),
    { timeout: 20_000 },
  )

  it.instance(
    "a cancelled search says so, and still hands over what it found",
    () =>
      Effect.gen(function* () {
        // Cancelled is partial, not failed, and the engine notes cannot carry it: they describe an engine that
        // answered badly, not a run that stopped.
        const stopped = new AbortController()
        stopped.abort()
        const result = yield* succeed({ query: "武汉大学" }, stopped.signal)
        expect(result.output).toContain("cancelled")
        expect(result.metadata.partial).toBe(true)
        expect(result.metadata.candidates).toBe(1)
      }),
    { timeout: 20_000 },
  )
})
