import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoOsm } from "../src/geo"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import FEATURES_DESCRIPTION from "../src/tool/geo-osm-features.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

/* Tripwires for OsmGetFeatures (docs/TOOLS.md §3; GEOKERNEL §6.4, §6.7, §6.8).
 *
 * The hardest answer in the set to check: a file of features nobody asked for
 * individually, where the wrong ones look exactly like the right ones. Two of
 * the lines guarded here are data contracts rather than commentary — the
 * superset that must be clipped, and the centroid count that shows what a
 * point-only query would have missed — and two are the ways a request can be
 * malformed in a way the kernel would answer with a confident zero.
 */

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

/** Runs the tool with the capability boundary lifted — see the first test. */
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

afterEach(async () => {
  await disposeAllInstances()
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
        // The kernel only checks an UPPER bound on extents. With none, the loop
        // runs zero times and comes back with zero features — which is exactly
        // what an area holding none of this category looks like.
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
        // `tags.forEach(tagClause)` over an empty list raises nothing, so the
        // kernel would build a query with no clauses at all.
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
      downloadFeatures: () => Effect.succeed(DOWNLOAD({ exact: false })),
    }),
  ).instance(
    "a widened boundary is stated before the figures, and never as something to clip",
    () =>
      Effect.gen(function* () {
        // The extents are mixed on purpose: that is the ONLY shape that still
        // reaches this line. A call made entirely of boundary files narrows
        // itself back before anything is counted (§6.4) and comes out exact.
        const result = yield* succeed({ ...ARGS, extents: ["file:/data/study.geojson", "area:R123"] })

        // Over-downloading can be corrected afterwards; under-downloading
        // cannot even be noticed (§6.4). The widening is deliberate — and
        // useless unless the caller is told the file holds more than asked.
        expect(result.output).toMatch(/covers more ground/)
        // ★ Never a clip. In this one surviving shape the other extents
        // legitimately hold features outside the boundary file, so cutting to
        // that file would delete exactly those — which is what the previous
        // wording, written before the automatic narrowing existed, advised.
        expect(result.output).not.toMatch(/clip/i)
        // A way out this caller can take, stated as a fact rather than an
        // instruction — and without a "this one" that says nothing when two
        // boundary files were widened.
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
        // Silence is the signal. A warning that appears every time is one the
        // reader stops seeing, and the common extents — an area id, a bounding
        // box, a radius — are always exact.
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

        // Never one mixed-geometry file, and the sibling names cannot be
        // guessed — a run may also have been numbered (§6.7).
        expect(result.output).toContain("/data/poi-points.geojson")
        expect(result.output).toContain("/data/poi-polygons.geojson")
        expect(result.output).toContain("816 feature(s)")
        // Overlapping sub-areas are safe to pass together, which is only true
        // because the merge deduplicates — and worth saying, because the count
        // is otherwise unexplained.
        expect(result.output).toContain("Extents: 3 of 3 completed")
        expect(result.output).toContain("17 cross-extent duplicate(s) removed")
        // The number that shows what asking for point ELEMENTS would have
        // missed: here 503 of 816 were mapped as areas or lines (§6.8).
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
            // Three asked for: one answered (incompletely), two never did. The
            // fixture adds up on purpose — one that does not is read as
            // documentation of a state that cannot happen.
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

        // A typo, a server that gave up, and elements that would not assemble
        // ask for three different responses. Collapsing them into "partial"
        // would leave the caller guessing which one happened.
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
        // Both extents answered; the category simply is not tagged that way
        // here. That is the one place a caller should suspect the tag union
        // rather than the network — and the sentence has to say which of the
        // two happened, because the responses are opposite.
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
        // Same empty file, opposite cause. Reading this one as "the tags are
        // wrong" sends the caller to rewrite a query that was fine.
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("0 of 2 extent(s) answered at all")
        expect(result.output).not.toMatch(/matched these tags/)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetFeatures, the description", () => {
  test("it keeps the rule that stops a POI dataset losing most of itself", () => {
    // Most facilities are mapped as areas, so asking for point ELEMENTS
    // silently returns the minority and looks complete (§6.8).
    expect(FEATURES_DESCRIPTION).toMatch(/do NOT use "node"/i)
    expect(FEATURES_DESCRIPTION).toContain("centroid")
  })

  test("it names no clipping algorithm", () => {
    // osmfetch holds `geo_osm_*` and `geo_qgis_read`; it cannot run an
    // algorithm (TOOLS.md §4.3). And the old build's `native:clip` was never
    // checked against the catalog — the same shape as the tool-name drift that
    // §8 records.
    expect(FEATURES_DESCRIPTION).not.toMatch(/native:/)
    expect(FEATURES_DESCRIPTION).not.toMatch(/RunQgisAlgorithm/)
  })

  test("and no clip at all, the same way the report names none", () => {
    // The report retracted this when the automatic narrowing landed (§6.4) and
    // is asserted on twice above; the description kept it, because nothing here
    // was watching the prose — `/clipped:/` below is about the metadata field of
    // that name, and a colon is what makes it miss a sentence.
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
        // §6.3 calls this the most dangerous failure there is: the answer is
        // real and short, and nothing about it looks wrong. It was narrated and
        // then left out of `partial` — an extent that stopped early is in
        // neither `done < asked` nor `failed` — so anything reading the
        // metadata channel saw a whole run.
        const result = yield* succeed(ARGS)
        expect(result.output).toContain("came back incomplete")
        expect(result.metadata.partial).toBe(true)
        expect(result.metadata.extents_incomplete).toBe(1)
      }),
    { timeout: 20_000 },
  )
})
