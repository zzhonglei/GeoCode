import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoOsm } from "../src/geo"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import PROBE_DESCRIPTION from "../src/tool/geo-osm-probe.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

// A count can be true and misleading at once, so what qualifies it has to reach the caller before the figure.

const COUNT = (over: Partial<GeoOsm.CountResult> = {}): GeoOsm.CountResult => ({
  perExtent: [{ extent: "area:R10717504", nodes: 210, ways: 128, relations: 4, total: 342 }],
  totals: { nodes: 210, ways: 128, relations: 4, total: 342 },
  failed: [],
  incomplete: [],
  exact: true,
  ...over,
})

const DISTRIBUTION = (over: Partial<GeoOsm.DistributionResult> = {}): GeoOsm.DistributionResult => ({
  key: "amenity",
  values: [
    { value: "parking", count: 1204 },
    { value: "restaurant", count: 318 },
  ],
  distinct: 2,
  sampled: 1522,
  truncated: false,
  failed: [],
  incomplete: [],
  // A distribution carries this itself; a count reads coverage off `perExtent` instead.
  answered: 1,
  exact: true,
  ...over,
})

function osmService(over: {
  count?: (input: { readonly extents: readonly string[] }) => Effect.Effect<GeoOsm.CountResult, Error>
  distribution?: (input: { readonly extents: readonly string[] }) => Effect.Effect<GeoOsm.DistributionResult, Error>
}) {
  return Layer.mock(GeoOsm.Service)({
    count: over.count ?? (() => Effect.succeed(COUNT())),
    distribution: over.distribution ?? (() => Effect.succeed(DISTRIBUTION())),
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
  const tool = (yield* registry.all()).find((item) => item.id === "OsmProbe")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_probe_test"),
      messageID: MessageID.make("msg_probe_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_probe_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(10_000), Effect.exit)
})

/** Runs the tool with the capability boundary lifted. */
const succeed = Effect.fnUntraced(function* (
  params: Record<string, unknown>,
  abort: AbortSignal = AbortSignal.any([]),
) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmProbe")
  expect(tool).toBeDefined()
  return yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_probe_test"),
    messageID: MessageID.make("msg_probe_test"),
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

describe("OsmProbe, the capability boundary", () => {
  harness(osmService({})).instance(
    "is registered, and reachable by nobody yet",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("OsmProbe")

        // Reaching the public OSM services is osmfetch's alone (docs/TOOLS.md §4.3).
        for (const agent of ["GeoAgent", "plan"]) {
          const denied = yield* execute({ extents: ["area:R1"], tags: ["amenity"] }, agent)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
        }
      }),
    { timeout: 20_000 },
  )
})

describe("OsmProbe, what it refuses to answer", () => {
  const it = harness(osmService({}))

  it.instance(
    "an empty extent list is refused, not answered with zero",
    () =>
      Effect.gen(function* () {
        // The kernel would sum nothing to zero and succeed, which is what an area holding no hospitals looks like.
        const result = yield* succeed({ extents: [], tags: ["amenity=hospital"] })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.metadata.failed).toBe(true)
        expect(result.output).toContain("empty")
        expect(result.output).not.toContain("total 0")
      }),
    { timeout: 20_000 },
  )

  it.instance(
    "the two modes are exclusive in both directions",
    () =>
      Effect.gen(function* () {
        const both = yield* succeed({ extents: ["area:R1"], tags: ["amenity"], key: "amenity" })
        expect(both.metadata.error_code).toBe("InvalidParameters")
        expect(both.output).toContain("both")

        const neither = yield* succeed({ extents: ["area:R1"] })
        expect(neither.metadata.error_code).toBe("InvalidParameters")
        expect(neither.output).toContain("neither")

        for (const outcome of [both, neither]) {
          expect(outcome.output).toContain("tags")
          expect(outcome.output).toContain("key")
        }
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      count: (input: any) => {
        // Filtered out here, the rest would be counted and nothing would say what went missing.
        expect(input.tags).toEqual(["amenity=hospital", ""])
        return Effect.fail(new Error("a tag filter cannot be empty"))
      },
    }),
  ).instance(
    "a blank tag is handed on, not quietly dropped",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1"], tags: ["amenity=hospital", ""] })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("a tag filter cannot be empty")
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      count: () => Effect.fail(new Error("13 extents is more than the 12 allowed in one call")),
    }),
  ).instance(
    "a whole-call mistake comes back as a sentence, not a defect",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1"], tags: ["amenity"] })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("more than the 12 allowed")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmProbe, counting", () => {
  harness(osmService({})).instance(
    "one extent gets its split, and no sum to mistake for a second area",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R10717504"], tags: ["amenity=hospital", "healthcare"] })
        expect(result.output).toContain("area:R10717504")
        expect(result.output).toContain("total 342")
        expect(result.output).toContain("nodes 210, ways 128, relations 4")
        expect(result.output).toContain("[amenity=hospital, healthcare]")
        expect(result.output).not.toContain("SUM")
        expect(result.metadata.total).toBe(342)
        expect(result.metadata.exact).toBe(true)
        expect(result.metadata.truncated).toBe(false)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      count: () =>
        Effect.succeed(
          COUNT({
            perExtent: [
              { extent: "area:R1", nodes: 10, ways: 5, relations: 1, total: 16 },
              { extent: "bbox:1,2,3,4", nodes: 20, ways: 4, relations: 0, total: 24 },
            ],
            totals: { nodes: 30, ways: 9, relations: 1, total: 40 },
          }),
        ),
    }),
  ).instance(
    "several extents are summed, so the split decision is one read",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1", "bbox:1,2,3,4"], tags: ["amenity"] })
        expect(result.output).toContain("SUM")
        expect(result.output).toContain("total 40")
        expect(result.metadata.extents_counted).toBe(2)
        expect(result.metadata.extents_asked).toBe(2)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      count: () =>
        Effect.succeed(
          COUNT({
            exact: false,
            incomplete: [{ extent: "area:R1", remark: "runtime error: Query timed out in 'query' after 90 seconds." }],
            failed: [{ extent: "bbox:9,9,9,9", reason: "all 8 Overpass endpoints failed across 2 rounds" }],
          }),
        ),
    }),
  ).instance(
    "every caveat reaches the caller, and reaches them before the figures",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1", "bbox:9,9,9,9"], tags: ["amenity"] })

        expect(result.output).toMatch(/widened outward/)
        expect(result.output).toMatch(/upper bound/)
        // The service's own words, since "timed out" and "too broad" ask for opposite moves.
        expect(result.output).toContain("runtime error: Query timed out in 'query' after 90 seconds.")
        expect(result.output).toContain("bbox:9,9,9,9")
        expect(result.output).toContain("all 8 Overpass endpoints failed")

        expect(result.output.indexOf("NOTE:")).toBeLessThan(result.output.indexOf("total 342"))

        expect(result.metadata.exact).toBe(false)
        expect(result.metadata.extents_failed).toBe(1)
        expect(result.metadata.extents_incomplete).toBe(1)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      count: () =>
        Effect.succeed(
          COUNT({
            perExtent: [],
            totals: { nodes: 0, ways: 0, relations: 0, total: 0 },
            failed: [
              { extent: "area:R1", reason: "all 8 Overpass endpoints failed across 2 rounds" },
              {
                extent: "bbox:1,2",
                reason: '"1,2" is not a bounding box: expected four numbers, south,west,north,east',
              },
            ],
          }),
        ),
    }),
  ).instance(
    "nothing counted is not dressed as a count of nothing",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1", "bbox:1,2"], tags: ["amenity"] })
        expect(result.metadata.error_code).toBe("AllExtentsFailed")
        expect(result.metadata.failed).toBe(true)
        expect(result.output).not.toContain("Counted [")
        expect(result.output).not.toContain("total 0")
        // A busy service and a typo are told apart only by the reason string.
        expect(result.output).toContain("all 8 Overpass endpoints failed")
        expect(result.output).toContain("is not a bounding box")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmProbe, the value distribution", () => {
  harness(osmService({})).instance(
    "values come back ranked, with the sample size that produced them",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1"], key: "amenity" })
        expect(result.output).toContain('Values of "amenity"')
        expect(result.output).toContain("parking")
        expect(result.output).toContain("1204")
        expect(result.output).toContain("1522 element(s) sampled")
        expect(result.metadata.mode).toBe("distribution")
        expect(result.metadata.distinct).toBe(2)
        expect(result.metadata.sample_capped).toBe(false)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      distribution: () =>
        Effect.succeed(
          DISTRIBUTION({
            values: Array.from({ length: 63 }, (_, index) => ({ value: `v${index}`, count: 63 - index })),
            distinct: 63,
            truncated: true,
          }),
        ),
    }),
  ).instance(
    "a long tail is summarized, and a capped sample says it is a lower bound",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1"], key: "amenity" })
        expect(result.output).toContain("v0")
        expect(result.output).toContain("v29")
        expect(result.output).not.toContain("v30 ")
        expect(result.output).toContain("and 33 more value(s)")
        // Before the list, since a capped sample can miss a value altogether.
        expect(result.output).toMatch(/lower bound/)
        expect(result.output.indexOf("lower bound")).toBeLessThan(result.output.indexOf("v0"))
        expect(result.metadata.sample_capped).toBe(true)
        // metadata.truncated is the output escape hatch in tool.ts, not the sample cap, and stays false.
        expect(result.metadata.truncated).toBe(false)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({ distribution: () => Effect.succeed(DISTRIBUTION({ values: [], distinct: 0, sampled: 0 })) }),
  ).instance(
    "a key nobody uses here is an answer, not a failure",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1"], key: "aerialway" })
        expect(result.output).toContain("No element")
        expect(result.output).toContain("aerialway")
        expect(result.metadata.error_code).toBeUndefined()
        expect(result.metadata.failed).toBeUndefined()
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      distribution: () =>
        Effect.succeed(
          DISTRIBUTION({
            values: [],
            distinct: 0,
            sampled: 0,
            failed: [{ extent: "area:R1", reason: "all 8 Overpass endpoints failed across 2 rounds" }],
          }),
        ),
    }),
  ).instance(
    "but a key nobody could ask about is a failure, not an answer",
    () =>
      Effect.gen(function* () {
        // The same empty distribution as above, where reading "this key is not used here" stops the caller looking.
        const result = yield* succeed({ extents: ["area:R1"], key: "aerialway" })
        expect(result.metadata.error_code).toBe("AllExtentsFailed")
        expect(result.output).not.toContain("No element")
        expect(result.output).toContain("all 8 Overpass endpoints failed")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmProbe, the description", () => {
  test("it warns about the wait", () => {
    // A model that reads a normal failover as a hang retries and pays the whole cost again (§11).
    expect(PROBE_DESCRIPTION).toContain("TIMING")
  })

  test("it explains all three kinds of NOTE, because they ask for different things", () => {
    expect(PROBE_DESCRIPTION).toMatch(/upper bound/)
    expect(PROBE_DESCRIPTION).toMatch(/own words/)
    expect(PROBE_DESCRIPTION).toMatch(/contributed nothing/)
  })

  test("it never points the model at metadata, which the model cannot see", () => {
    expect(PROBE_DESCRIPTION).not.toMatch(/metadata/i)
  })
})

describe("OsmProbe, what qualifies the numbers", () => {
  harness(osmService({ distribution: () => Effect.succeed(DISTRIBUTION({ exact: false })) })).instance(
    "distribution mode reports a widened boundary too, which it used to swallow",
    () =>
      Effect.gen(function* () {
        // Without exact on the result, a distribution taken over a convex hull describes the hull without saying so.
        const result = yield* succeed({ extents: ["file:/study.geojson"], key: "amenity" })
        expect(result.output).toContain("widened outward")
        expect(result.output).toContain("upper bound")
        expect(result.metadata.exact).toBe(false)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      distribution: () =>
        Effect.succeed(DISTRIBUTION({ answered: 2, failed: [{ extent: "area:R9", reason: "endpoints failed" }] })),
    }),
  ).instance(
    "the coverage it claims is the coverage it got",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ extents: ["area:R1", "area:R9", "area:R3", "area:R4"], key: "amenity" })
        expect(result.output).toContain("2 of 4 extent(s)")
        expect(result.output).not.toMatch(/across 4 extent/)
        expect(result.metadata.extents_answered).toBe(2)
      }),
    { timeout: 20_000 },
  )

  harness(osmService({ distribution: () => Effect.succeed(DISTRIBUTION({ answered: 2 })) })).instance(
    "a run stopped partway says so, even though it has numbers to show",
    () =>
      Effect.gen(function* () {
        const stopped = new AbortController()
        stopped.abort()
        const result = yield* succeed({ extents: ["area:R1", "area:R2", "area:R3"], key: "amenity" }, stopped.signal)
        expect(result.output).toContain("cancelled")
        expect(result.output).toContain("parking")
      }),
    { timeout: 20_000 },
  )
})
