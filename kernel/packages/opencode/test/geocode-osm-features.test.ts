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

/* Tripwires for OsmGetFeatures (docs/TOOLS.md §3; GEOKERNEL §6.4, §6.7, §6.8). A file of the wrong features looks
 * exactly like a file of the right ones, so two report lines are data contracts — the superset a widened boundary
 * leaves behind, and the centroid count — and two more are the malformed calls the kernel answers with a zero. */

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

/** Runs the tool with the capability boundary the test below pins lifted, so its printing can be reached. */
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

/** Runs the tool with everything granted, keeping each permission it asked for. */
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

/** Runs the tool and keeps every live metadata push it made along the way. */
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
  /* The two properties OsmGetObjects's tests reason out, repeated because the two tools carry separate copies of
   * this code, plus the ordering: the parameter refusals sit ahead of both asks. */
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
        // The kernel bounds the extent count from above only, and its zero-features answer to an empty list is what
        // an area holding none of this category answers with too.
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
        // Mixed extents on purpose, the only shape that still reaches this line: a call made only of boundary files
        // narrows itself back before anything is counted (§6.4).
        const result = yield* succeed({ ...ARGS, extents: ["file:/data/study.geojson", "area:R123"] })

        // The widening is deliberate, and useless unless the caller is told the file holds more than was asked for.
        expect(result.output).toMatch(/covers more ground/)
        // Which boundary, since the way out is to ask for that one on its own and a call can carry several.
        expect(result.output).toContain("boundary file study.geojson (3 polygons, reduced to convex hulls)")
        // Never a clip: the other extents legitimately hold features outside the boundary file, and cutting to it
        // would delete exactly those.
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
        // Silence is the signal: an area id, a bounding box and a radius are exact, and a warning printed over all
        // three is one the reader stops seeing.
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

        // Never one mixed-geometry file, and the sibling paths cannot be guessed from the one asked for (§6.7).
        expect(result.output).toContain("/data/poi-points.geojson")
        expect(result.output).toContain("/data/poi-polygons.geojson")
        expect(result.output).toContain("816 feature(s)")
        // Overlapping sub-areas are safe to pass together only because the merge deduplicates.
        expect(result.output).toContain("Extents: 3 of 3 completed")
        expect(result.output).toContain("17 cross-extent duplicate(s) removed")
        // What asking for point elements would have missed: 503 of the 816 are mapped as areas or lines (§6.8).
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
            // Three asked for: one answered incompletely, two never did — a fixture that did not add up would
            // document a state that cannot happen.
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

        // A typo, a server that gave up and elements that would not assemble ask for three different responses.
        expect(result.output).toContain("is not an extent")
        expect(result.output).toContain("runtime error: Query timed out after 120 seconds.")
        expect(result.output).toContain("W4411, R902")
        expect(result.output).toContain("Extents: 1 of 3 completed")
        // Whatever succeeded is already in the file (§6.7).
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
        // Both extents answered, so the tag union is what to suspect and not the network.
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
        // Same empty file, opposite cause: read as "the tags are wrong" it sends the caller to rewrite a fine query.
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("0 of 2 extent(s) answered at all")
        expect(result.output).not.toMatch(/matched these tags/)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, the description", () => {
  test("it keeps the rule that stops a POI dataset losing most of itself", () => {
    // Most facilities are mapped as areas, so asking for point elements returns the minority and looks whole (§6.8).
    expect(FEATURES_DESCRIPTION).toMatch(/do NOT use "node"/i)
    expect(FEATURES_DESCRIPTION).toContain("centroid")
  })

  test("it names no clipping algorithm", () => {
    // osmfetch, the one agent that reads this, is denied `qgis` and so cannot run an algorithm (docs/TOOLS.md §4.3).
    expect(FEATURES_DESCRIPTION).not.toMatch(/native:/)
    expect(FEATURES_DESCRIPTION).not.toMatch(/RunQgisAlgorithm/)
  })

  test("and no clip at all, the same way the report names none", () => {
    // The `/clipped:/` check below is colon-anchored on purpose, so it catches a field-style promise and misses
    // a sentence about clipping.
    expect(FEATURES_DESCRIPTION).not.toMatch(/clip/i)
  })

  test("it never points the model at metadata, which the model cannot see", () => {
    expect(FEATURES_DESCRIPTION).not.toMatch(/metadata/i)
    expect(FEATURES_DESCRIPTION).not.toMatch(/clipped:/)
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
        // An extent that stopped early sits in neither `done < asked` nor `failed`, so `partial` is the only place
        // a real, short answer is distinguishable from a whole one (§6.3).
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("came back incomplete")
        expect(result.metadata.partial).toBe(true)
        expect(result.metadata.extents_incomplete).toBe(1)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, saying so while it runs", () => {
  /* The slowest thing the OSM group does — a dense city can spend minutes on a single extent — so the count
   * reaches the caller while it runs, the way RunQgisAlgorithm's `onChunk` does (docs/GEOKERNEL.md §6.8). */

  it_progress()
  function it_progress() {
    /** A kernel that reports its way through five extents, the third failing. */
    const reporting = osmService({
      downloadFeatures: (input) =>
        Effect.gen(function* () {
          // Typed rather than left to the `any` the mock helper takes: yielding an untyped effect widens this
          // generator's error channel to `unknown`, and the mock stops satisfying the service.
          const report = input.onProgress as GeoOsm.OnProgress
          // What the kernel does: an opening tick, then one per extent as it settles.
          yield* report(0, 5)
          for (let settled = 1; settled <= 5; settled++) yield* report(settled, 5)
          return DOWNLOAD({ extentsDone: 4, extentsAsked: 5, failed: [{ extent: "bbox:3", reason: "timeout" }] })
        }),
    })

    harness(reporting).instance("the count reaches the caller while the download is still running", () =>
      Effect.gen(function* () {
        const { pushed } = yield* pushesOf({ ...ARGS, extents: ["a", "b", "c", "d", "e"] })

        // A kernel counting into a callback nobody passed is what neither side of this can see alone.
        expect(pushed.map((entry) => entry.extents_settled)).toEqual([0, 1, 2, 3, 4, 5])
        for (const entry of pushed) expect(entry.extents_asked).toBe(5)

        // The opening tick included, or the common one-extent download reports nothing until it is over.
        expect(pushed[0]!.extents_settled).toBe(0)

        // Never the generic head-truncation, which keeps the head and drops the tail, where a download's ending
        // lives (docs/TOOLS.md §5).
        for (const entry of pushed) expect(entry.truncated).toBe(false)
      }),
    )

    harness(reporting).instance("progress counts what is settled, and the result still says what happened", () =>
      Effect.gen(function* () {
        // `extents_settled` answers "how much longer" and counts the failed extent; `extents_done` answers "what
        // did I get" and does not.
        const { pushed, result } = yield* pushesOf({ ...ARGS, extents: ["a", "b", "c", "d", "e"] })
        expect(pushed.at(-1)!.extents_settled).toBe(5)
        expect(result.metadata.extents_done).toBe(4)
        expect(result.metadata.extents_failed).toBe(1)
        // And the live pushes claim no outcome field, which a reader could take a mid-run number from.
        for (const entry of pushed) expect(entry.extents_done).toBeUndefined()
      }),
    )
  }
})
