import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoOsm } from "../src/geo"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import OBJECTS_DESCRIPTION from "../src/tool/geo-osm-objects.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

/* Tripwires for OsmGetObjects (docs/TOOLS.md §3; GEOKERNEL §6.7, §6.8).
 *
 * The first tool that leaves a file behind, so the report stops being a
 * description of an answer and becomes the only record of what the file does
 * not contain. Three things are guarded because nothing downstream can
 * recover them: the paths actually written (which need not be the path asked
 * for), the identity of every object that went missing, and the difference
 * between "nothing was written" and "nothing was found".
 */

const DOWNLOAD = (over: Partial<GeoOsm.DownloadResult> = {}): GeoOsm.DownloadResult => ({
  outputs: [{ path: "/data/wuhan.geojson", count: 2, family: "polygons" }],
  features: 2,
  bytes: 188_620,
  keptFields: ["osm_id", "osm_type", "name", "category", "admin_level"],
  geometry: { MultiPolygon: 2 },
  droppedFields: ["wikidata(2)", "population(1)"],
  unassembled: [],
  failed: [],
  incomplete: [],
  extentsDone: 2,
  extentsAsked: 2,
  duplicates: 0,
  centroidConverted: 0,
  exact: true,
  notes: [],
  ...over,
})

/** An OSM service under the test's control — no network, no disk. */
function osmService(over: { downloadObjects?: (input: any) => Effect.Effect<GeoOsm.DownloadResult, Error> }) {
  return Layer.mock(GeoOsm.Service)({
    downloadObjects: over.downloadObjects ?? (() => Effect.succeed(DOWNLOAD())),
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
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetObjects")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_obj_test"),
      messageID: MessageID.make("msg_obj_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_obj_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(10_000), Effect.exit)
})

/** Runs the tool with the capability boundary lifted — see the first test. */
const succeed = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetObjects")
  expect(tool).toBeDefined()
  return yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_obj_test"),
    messageID: MessageID.make("msg_obj_test"),
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

describe("OsmGetObjects, the capability boundary", () => {
  harness(osmService({})).instance(
    "is registered, and reachable by nobody yet",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("OsmGetObjects")

        for (const agent of ["GeoAgent", "plan"]) {
          const denied = yield* execute({ ids: ["R1"], output: "/data/x.geojson" }, agent)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
        }
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadObjects: () => Effect.fail(new Error("26 ids is more than the 25 allowed in one call")),
    }),
  ).instance(
    "a whole-call mistake comes back as a sentence, not a defect",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ids: ["R1"], output: "/data/x.geojson" })
        expect(result.metadata.error_code).toBe("InvalidParameters")
        expect(result.output).toContain("more than the 25 allowed")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetObjects, where the file actually is", () => {
  harness(
    osmService({
      // The kernel appends the extension, because the sibling names for a split
      // are derived from the base and a base without one collides with them.
      downloadObjects: () =>
        Effect.succeed(DOWNLOAD({ outputs: [{ path: "/data/wuhan.geojson", count: 2, family: "polygons" }] })),
    }),
  ).instance(
    "the path reported is the one written, not the one requested",
    () =>
      Effect.gen(function* () {
        // Echoing the request would be a lie in exactly the case where it
        // matters: the caller opens a path that was never created.
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/wuhan" })
        expect(result.output).toContain("/data/wuhan.geojson")
        expect(result.output).not.toMatch(/to \/data\/wuhan \(/)
        expect(result.metadata.outputs).toEqual([{ path: "/data/wuhan.geojson", count: 2, family: "polygons" }])
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadObjects: () =>
        Effect.succeed(
          DOWNLOAD({
            outputs: [
              { path: "/data/campus-polygons.geojson", count: 3, family: "polygons" },
              { path: "/data/campus-points.geojson", count: 1, family: "points" },
            ],
            features: 4,
            extentsAsked: 4,
            geometry: { Polygon: 3, Point: 1 },
          }),
        ),
    }),
  ).instance(
    "a split names every sibling, because a caller cannot guess them",
    () =>
      Effect.gen(function* () {
        // Never one mixed-geometry file (§6.7): GIS tools work a family at a
        // time and format conversion refuses the mix outright. The split is
        // silent unless the report lists what it produced.
        const result = yield* succeed({ ids: ["R1", "R2", "R3", "W4"], output: "/data/campus.geojson" })
        expect(result.output).toContain("/data/campus-polygons.geojson")
        expect(result.output).toContain("/data/campus-points.geojson")
        expect(result.output).toContain("polygons: 3")
        expect(result.output).toContain("points: 1")
        expect((result.metadata.outputs as unknown[]).length).toBe(2)
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetObjects, what did not make it", () => {
  harness(
    osmService({
      downloadObjects: () =>
        Effect.succeed(
          DOWNLOAD({
            // Four asked for: one written, one refused, two that matched and
            // would not assemble. The fixture adds up on purpose — a fixture
            // that does not is read as documentation of a state that cannot
            // happen.
            features: 1,
            extentsDone: 1,
            extentsAsked: 4,
            outputs: [{ path: "/data/b.geojson", count: 1, family: "polygons" }],
            failed: [
              {
                extent: "R3076268",
                reason: "only 182 of about 4613 vertices were stitched; refusing to hand over a partial boundary",
              },
            ],
            unassembled: ["N999", "W888"],
          }),
        ),
    }),
  ).instance(
    "every loss is named by id, and the ratio makes the gap countable",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ids: ["R3076268", "N999", "W888", "R2"], output: "/data/b.geojson" })

        // The guard that made this a failure instead of a silent half-boundary
        // was found live on a real city relation. Its wording carries the
        // evidence — a partial boundary looks exactly like a boundary.
        expect(result.output).toContain("only 182 of about 4613 vertices were stitched")
        // By identity, not by count: the fix for a dropped object is to ask for
        // it alone, which needs to know which one it was.
        expect(result.output).toContain("N999, W888")
        expect(result.output).toContain("1 of 4 object(s)")
        expect(result.metadata.unassembled).toEqual(["N999", "W888"])
        expect(result.metadata.partial).toBe(true)
        // And before the figures, as everywhere in this group.
        expect(result.output.indexOf("NOTE:")).toBeLessThan(result.output.indexOf("Wrote"))
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadObjects: () =>
        Effect.succeed(
          DOWNLOAD({
            outputs: [],
            features: 0,
            bytes: 0,
            extentsDone: 0,
            extentsAsked: 2,
            geometry: {},
            failed: [
              { extent: "R1", reason: "all 8 Overpass endpoints failed across 2 rounds" },
              { extent: "R2", reason: "all 8 Overpass endpoints failed across 2 rounds" },
            ],
            notes: ["nothing was obtained, so no file was written"],
          }),
        ),
    }),
  ).instance(
    "a run that wrote nothing says so, and says how much was asked for",
    () =>
      Effect.gen(function* () {
        // An empty run creates no file — nothing here overwrites, so there is
        // nothing to protect and nothing to write either. What the caller must
        // not do is read the silence as success, which is why the sentence
        // states the size of the request rather than only the outcome.
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/b.geojson" })
        expect(result.output).toContain("None of the 2 requested object(s) could be obtained")
        expect(result.output).not.toContain("Wrote")
        expect(result.metadata.error_code).toBe("NothingObtained")
        expect(result.metadata.failed).toBe(true)
      }),
    { timeout: 20_000 },
  )

  /* The batched fetch reports trouble through two channels that the kernel
   * never uses at once — a remark means it answered, a note means it did not.
   * They are asserted separately because a fixture carrying both would
   * document a state that cannot occur.
   *
   * Either way the caller has to hear it: a batch cut short drops objects into
   * the per-object route, which is the unreliable one, and read without this
   * its troubles look like "these objects are a problem" rather than "the fast
   * path was cut short". */
  harness(
    osmService({
      downloadObjects: () =>
        Effect.succeed(
          DOWNLOAD({
            incomplete: [{ extent: "the batched fetch", remark: "runtime error: Query timed out after 120 seconds." }],
          }),
        ),
    }),
  ).instance(
    "a batch that answered and said it was cut short",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/b.geojson" })
        expect(result.output).toContain("runtime error: Query timed out after 120 seconds.")
      }),
    { timeout: 20_000 },
  )

  harness(
    osmService({
      downloadObjects: () =>
        Effect.succeed(
          DOWNLOAD({ notes: ["the batched fetch failed (HTTP 504); falling back to one request per object"] }),
        ),
    }),
  ).instance(
    "a batch that did not answer at all",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/b.geojson" })
        expect(result.output).toContain("falling back to one request per object")
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetObjects, the field contract", () => {
  harness(osmService({})).instance(
    "dropped keys are counted and recoverable",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/wuhan.geojson" })
        expect(result.output).toContain("osm_id, osm_type, name, category, admin_level")
        // Which keys, and how many carried them — enough to decide whether a
        // second call is worth it, and the route to make one.
        expect(result.output).toContain("wikidata(2)")
        expect(result.output).toContain("fields:[...]")
        expect(result.output).toContain('fields:["*"]')
        expect(result.output).toContain("EPSG:4326")
        expect(result.metadata.dropped_fields).toEqual(["wikidata(2)", "population(1)"])
        expect(result.metadata.partial).toBeUndefined()
      }),
    { timeout: 20_000 },
  )
})

describe("OsmGetObjects, the description", () => {
  test("it states the limit the kernel actually enforces", () => {
    // The old build's copy said "keep the set under about 10" while the code
    // refused at 25 — a number nobody could act on, in either direction.
    expect(OBJECTS_DESCRIPTION).toContain("25")
    expect(OBJECTS_DESCRIPTION).not.toMatch(/under about 10/)
  })

  test("it never points the model at metadata, which the model cannot see", () => {
    // GEOKERNEL §9.1: only `state.output` reaches a model message. The old
    // build taught metadata.missing and metadata.outputs — a channel the model
    // has never been able to read.
    expect(OBJECTS_DESCRIPTION).not.toMatch(/metadata/i)
  })

  test("it leaves the verification discipline to the subagent that holds the permission", () => {
    // osmfetch is granted `geo_qgis_read` and nothing else from the QGIS group,
    // precisely so it can check its own downloads (TOOLS.md §4.3). A standing
    // working rule belongs in that agent's prompt, not repeated in the copy of
    // every tool it may call — and repeated copies drift.
    expect(OBJECTS_DESCRIPTION).not.toMatch(/ReadGeoData/)
  })

  test("it warns about the wait", () => {
    expect(OBJECTS_DESCRIPTION).toContain("TIMING")
  })
})
