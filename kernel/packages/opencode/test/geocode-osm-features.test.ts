import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { InstanceState } from "../src/effect/instance-state"
import { GeoKernel, GeoOsm } from "../src/geo"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import FEATURES_DESCRIPTION from "../src/tool/geo-osm-features.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

// A file of the wrong features looks exactly like a file of the right ones, so the report lines are data contracts.

const DOWNLOAD = (over: Partial<GeoOsm.DownloadResult> = {}): GeoOsm.DownloadResult => ({
  outputs: [{ path: "/data/roads.geojson", count: 1204, family: "lines" }],
  features: 1204,
  bytes: 2_411_000,
  keptFields: ["osm_id", "osm_type", "name", "category", "highway"],
  geometry: { LineString: 1204 },
  droppedFields: ["maxspeed(310)", "lanes(88)"],
  unassembled: [],
  failed: [],
  incomplete: [],
  extentsDone: 1,
  extentsAsked: 1,
  duplicates: 0,
  centroidConverted: 0,
  exact: true,
  widened: [],
  notes: [],
  ...over,
})

function osmService(over: { downloadFeatures?: (input: any) => Effect.Effect<GeoOsm.DownloadResult, Error> }) {
  return Layer.mock(GeoOsm.Service)({
    downloadFeatures: over.downloadFeatures ?? (() => Effect.succeed(DOWNLOAD())),
  })
}

const harness = (osm: Layer.Layer<GeoOsm.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoOsm.node, osm],
    ]),
  )

const ARGS = { extents: ["bbox:30,114,31,115"], tags: ["highway"], output: "/data/roads.geojson" }

const execute = Effect.fnUntraced(function* (params: Record<string, unknown>, agentName = "GeoAgent") {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetFeatures")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_feat_test"),
      messageID: MessageID.make("msg_feat_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_feat_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(10_000), Effect.exit)
})

/** Runs the tool with the capability boundary lifted. */
const succeed = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetFeatures")
  expect(tool).toBeDefined()
  return yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_feat_test"),
    messageID: MessageID.make("msg_feat_test"),
    agent: "GeoAgent",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  })
})

const asksOf = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetFeatures")
  expect(tool).toBeDefined()
  const asked: { permission: string; patterns: readonly string[] }[] = []
  yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_feat_ask"),
    messageID: MessageID.make("msg_feat_ask"),
    agent: "GeoAgent",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        asked.push({ permission: req.permission, patterns: req.patterns })
      }),
  })
  return asked
})

const pushesOf = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetFeatures")
  expect(tool).toBeDefined()
  const pushed: Record<string, unknown>[] = []
  const result = yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_feat_progress"),
    messageID: MessageID.make("msg_feat_progress"),
    agent: "GeoAgent",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: (update) =>
      Effect.sync(() => {
        pushed.push((update as { metadata: Record<string, unknown> }).metadata)
      }),
    ask: () => Effect.void,
  })
  return { pushed, result }
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("OsmGetFeatures, what it asks permission for", () => {
  // Repeated from OsmGetObjects's tests because the two tools carry separate copies of this code.
  harness(osmService({})).instance("the pattern is worktree-relative, and an outside path asks for the directory", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context

      const inside = yield* asksOf({
        extents: ["bbox:114.0,30.4,114.5,30.7"],
        tags: ["amenity=hospital"],
        output: path.join(instance.directory, "data", "hospitals.geojson"),
      })
      const pattern = inside.find((item) => item.permission === "osm")?.patterns[0]
      expect(pattern).toBeDefined()
      expect(path.isAbsolute(pattern!)).toBe(false)
      expect(pattern).toContain("hospitals.geojson")
      expect(inside.map((item) => item.permission)).not.toContain("external_directory")

      const outside = yield* asksOf({
        extents: ["bbox:114.0,30.4,114.5,30.7"],
        tags: ["amenity=hospital"],
        output: "/geocode-outside-test.geojson",
      })
      expect(outside.map((item) => item.permission)).toContain("external_directory")
    }),
  )

  harness(osmService({})).instance("a malformed call raises no prompt at all", () =>
    Effect.gen(function* () {
      const asked = yield* asksOf({ extents: [], tags: ["amenity=hospital"], output: "/geocode-outside-test.geojson" })
      expect(asked).toEqual([])
    }),
  )
})

describe("OsmGetFeatures, the capability boundary", () => {
  harness(osmService({})).instance(
    "is registered, and reachable by nobody yet",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("OsmGetFeatures")

        for (const agent of ["GeoAgent", "plan"]) {
          const denied = yield* execute(ARGS, agent)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
        }
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, what it refuses to answer", () => {
  const it = harness(osmService({}))

  it.instance(
    "an empty extent list is refused, not answered with zero features",
    () =>
      Effect.gen(function* () {
        // The kernel answers an empty list with zero features, the same answer as an area holding none.
        const result = yield* succeed({ ...ARGS, extents: [] })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("empty")
        expect(result.output).not.toContain("Wrote")
      }),
    { timeout: 20_000 },
  )

  it.instance(
    "an empty tag list is refused for the same reason",
    () =>
      Effect.gen(function* () {
        // `tags.forEach(OsmQuery.tagClause)` raises nothing on an empty list, so the query goes out with no clauses.
        const result = yield* succeed({ ...ARGS, tags: [] })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("tag filter")
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadFeatures: () => Effect.fail(new Error("13 extents is more than the 12 allowed in one call")),
    }),
  ).instance(
    "a whole-call mistake comes back as a sentence, not a defect",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed(ARGS)
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("more than the 12 allowed")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, the superset contract", () => {
  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            exact: false,
            widened: ["boundary file study.geojson (3 polygons, reduced to convex hulls)"],
          }),
        ),
    }),
  ).instance(
    "a widened boundary is named, stated before the figures, and never something to clip",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ...ARGS, extents: ["file:/data/study.geojson", "area:R123"] })

        expect(result.output).toMatch(/covers more ground/)
        expect(result.output).toContain("boundary file study.geojson (3 polygons, reduced to convex hulls)")
        // Clipping to the boundary file would delete the features the other extents legitimately hold.
        expect(result.output).not.toMatch(/clip/i)
        expect(result.output).toMatch(/only of boundary files comes back exact/)
        expect(result.output.indexOf("NOTE:")).toBeLessThan(result.output.indexOf("Wrote"))
        expect(result.metadata.exact).toBe(false)
      }),
    { timeout: 20_000 },
  )

  harness(osmService({})).instance(
    "and an exact result says nothing at all about clipping",
    () =>
      Effect.gen(function* () {
        // A warning printed over exact results too is one the reader stops seeing.
        const result = yield* succeed(ARGS)
        expect(result.output).not.toMatch(/widened/)
        expect(result.output).not.toMatch(/clip/i)
        expect(result.metadata.exact).toBe(true)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, reading the result", () => {
  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            outputs: [
              { path: "/data/poi-points.geojson", count: 812, family: "points" },
              { path: "/data/poi-polygons.geojson", count: 4, family: "polygons" },
            ],
            features: 816,
            geometry: { Point: 812, Polygon: 4 },
            extentsDone: 3,
            extentsAsked: 3,
            duplicates: 17,
            centroidConverted: 503,
          }),
        ),
    }),
  ).instance(
    "the split, the tally and the centroid count all reach the caller",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ...ARGS, geometry: "centroid" })

        // The sibling paths cannot be guessed from the one asked for.
        expect(result.output).toContain("/data/poi-points.geojson")
        expect(result.output).toContain("/data/poi-polygons.geojson")
        expect(result.output).toContain("816 feature(s)")
        // Overlapping sub-areas are safe to pass together only because the merge deduplicates.
        expect(result.output).toContain("Extents: 3 of 3 completed")
        expect(result.output).toContain("17 cross-extent duplicate(s) removed")
        expect(result.output).toContain("503 area or line feature(s)")
        expect(result.output).toContain("original_geometry")
        expect(result.metadata.centroid_converted).toBe(503)
        expect(result.metadata.partial).toBeUndefined()
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            features: 402,
            extentsDone: 1,
            extentsAsked: 3,
            failed: [
              { extent: "nonsense", reason: '"nonsense" is not an extent: expected "area:R<id>", ...' },
              { extent: "area:R7", reason: "all 8 Overpass endpoints failed across 2 rounds" },
            ],
            incomplete: [{ extent: "bbox:30,114,31,115", remark: "runtime error: Query timed out after 120 seconds." }],
            unassembled: ["W4411", "R902"],
          }),
        ),
    }),
  ).instance(
    "three kinds of shortfall stay three kinds",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed(ARGS)

        expect(result.output).toContain("is not an extent")
        expect(result.output).toContain("runtime error: Query timed out after 120 seconds.")
        expect(result.output).toContain("W4411, R902")
        expect(result.output).toContain("Extents: 1 of 3 completed")
        expect(result.output).toContain("402 feature(s)")
        expect(result.metadata.partial).toBe(true)
        expect(result.metadata.unassembled).toEqual(["W4411", "R902"])
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            outputs: [],
            features: 0,
            bytes: 0,
            extentsDone: 2,
            extentsAsked: 2,
            geometry: {},
            droppedFields: [],
            notes: ["nothing was obtained, so no file was written"],
          }),
        ),
    }),
  ).instance(
    "nothing matched is told apart from nothing answered",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("All 2 extent(s) answered, and nothing in them matched these tags")
        expect(result.output).not.toContain("Wrote")
        expect(result.metadata.error_code).toBe("NothingObtained")
        expect(result.metadata.features).toBe(0)
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            outputs: [],
            features: 0,
            bytes: 0,
            extentsDone: 0,
            extentsAsked: 2,
            geometry: {},
            droppedFields: [],
            failed: [
              { extent: "bbox:30,114,31,115", reason: "all 8 Overpass endpoints failed across 2 rounds" },
              { extent: "area:R7", reason: "all 8 Overpass endpoints failed across 2 rounds" },
            ],
            notes: ["nothing was obtained, so no file was written"],
          }),
        ),
    }),
  ).instance(
    "and nothing answered says that instead",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("0 of 2 extent(s) answered at all")
        expect(result.output).not.toMatch(/matched these tags/)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, the description", () => {
  test("it keeps the rule that stops a POI dataset losing most of itself", () => {
    expect(FEATURES_DESCRIPTION).toMatch(/do NOT use "node"/i)
    expect(FEATURES_DESCRIPTION).toContain("centroid")
  })

  test("it names no clipping algorithm", () => {
    // osmfetch, the only agent that reads this, is denied qgis.
    expect(FEATURES_DESCRIPTION).not.toMatch(/native:/)
    expect(FEATURES_DESCRIPTION).not.toMatch(/RunQgisAlgorithm/)
  })

  test("and no clip at all, the same way the report names none", () => {
    expect(FEATURES_DESCRIPTION).not.toMatch(/clip/i)
  })

  test("it never points the model at metadata, which the model cannot see", () => {
    expect(FEATURES_DESCRIPTION).not.toMatch(/metadata/i)
  })

  test("it leaves the verification discipline to the subagent that holds the permission", () => {
    expect(FEATURES_DESCRIPTION).not.toMatch(/ReadGeoData/)
  })

  test("it warns about the wait", () => {
    expect(FEATURES_DESCRIPTION).toContain("TIMING")
  })
})

describe("OsmGetFeatures, a shortfall that does not look like one", () => {
  harness(
    osmService({
      downloadFeatures: () =>
        Effect.succeed(
          DOWNLOAD({
            incomplete: [{ extent: "bbox:30,114,31,115", remark: "runtime error: Query timed out after 120 seconds." }],
          }),
        ),
    }),
  ).instance(
    "a service that answered early makes the run partial in metadata, not only in prose",
    () =>
      Effect.gen(function* () {
        // An extent that stopped early is in neither done < asked nor failed, so only partial marks the answer short.
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("came back incomplete")
        expect(result.metadata.partial).toBe(true)
        expect(result.metadata.extents_incomplete).toBe(1)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, saying so while it runs", () => {
  it_progress()
  function it_progress() {
    const reporting = osmService({
      downloadFeatures: (input) =>
        Effect.gen(function* () {
          const report = input.onProgress as GeoOsm.OnProgress
          // Like the kernel: an opening tick, then one per extent as it settles.
          yield* report(0, 5)
          for (let settled = 1; settled <= 5; settled++) yield* report(settled, 5)
          return DOWNLOAD({ extentsDone: 4, extentsAsked: 5, failed: [{ extent: "bbox:3", reason: "timeout" }] })
        }),
    })

    harness(reporting).instance("the count reaches the caller while the download is still running", () =>
      Effect.gen(function* () {
        const { pushed } = yield* pushesOf({ ...ARGS, extents: ["a", "b", "c", "d", "e"] })

        // A kernel counting into a callback the tool never passed is what neither side sees alone.
        expect(pushed.map((entry) => entry.extents_settled)).toEqual([0, 1, 2, 3, 4, 5])
        for (const entry of pushed) expect(entry.extents_asked).toBe(5)

        // The opening tick included, or the common one-extent download reports nothing until it is over.
        expect(pushed[0]!.extents_settled).toBe(0)
      }),
    )

    harness(reporting).instance("progress counts what is settled, and the result still says what happened", () =>
      Effect.gen(function* () {
        // extents_settled counts the failed extent to say how much longer; extents_done does not.
        const { pushed, result } = yield* pushesOf({ ...ARGS, extents: ["a", "b", "c", "d", "e"] })
        expect(pushed.at(-1)!.extents_settled).toBe(5)
        expect(result.metadata.extents_done).toBe(4)
        expect(result.metadata.extents_failed).toBe(1)
        // Live pushes carry no outcome field a reader could take a mid-run number from.
        for (const entry of pushed) expect(entry.extents_done).toBeUndefined()
      }),
    )
  }
})
