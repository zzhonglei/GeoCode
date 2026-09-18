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
import OBJECTS_DESCRIPTION from "../src/tool/geo-osm-objects.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

// The report is the only record of what the written file does not hold, and nothing downstream can recover it.

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
  widened: [],
  notes: [],
  ...over,
})

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

/** Runs the tool with the capability boundary lifted. */
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

const asksOf = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetObjects")
  expect(tool).toBeDefined()
  const asked: { permission: string; patterns: readonly string[] }[] = []
  yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_obj_ask"),
    messageID: MessageID.make("msg_obj_ask"),
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
  const tool = (yield* registry.all()).find((item) => item.id === "OsmGetObjects")
  expect(tool).toBeDefined()
  const pushed: Record<string, unknown>[] = []
  yield* tool!.execute(params, {
    sessionID: SessionID.make("ses_obj_progress"),
    messageID: MessageID.make("msg_obj_progress"),
    agent: "GeoAgent",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: (update) =>
      Effect.sync(() => {
        pushed.push((update as { metadata: Record<string, unknown> }).metadata)
      }),
    ask: () => Effect.void,
  })
  return pushed
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("OsmGetObjects, what it asks permission for", () => {
  // Neither shows in the output: an absolute pattern silently matches none of the worktree-relative rules a user
  // writes, and an outside path has to reach osmfetch's external_directory ask.
  harness(osmService({})).instance("the pattern is worktree-relative, and an outside path asks for the directory", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context

      const inside = yield* asksOf({
        ids: ["R10717504"],
        output: path.join(instance.directory, "data", "wuhan.geojson"),
      })
      const pattern = inside.find((item) => item.permission === "osm")?.patterns[0]
      expect(pattern).toBeDefined()
      expect(path.isAbsolute(pattern!)).toBe(false)
      expect(pattern).toContain("wuhan.geojson")
      expect(inside.map((item) => item.permission)).not.toContain("external_directory")

      const outside = yield* asksOf({ ids: ["R10717504"], output: "/geocode-outside-test.geojson" })
      expect(outside.map((item) => item.permission)).toContain("external_directory")
    }),
  )
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
      downloadObjects: () =>
        Effect.succeed(DOWNLOAD({ outputs: [{ path: "/data/wuhan.geojson", count: 2, family: "polygons" }] })),
    }),
  ).instance(
    "the path reported is the one written, not the one requested",
    () =>
      Effect.gen(function* () {
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

        // A half-stitched boundary looks exactly like a boundary, so the reason has to carry the count.
        expect(result.output).toContain("only 182 of about 4613 vertices were stitched")
        expect(result.output).toContain("N999, W888")
        expect(result.output).toContain("1 of 4 object(s)")
        expect(result.metadata.unassembled).toEqual(["N999", "W888"])
        expect(result.metadata.partial).toBe(true)
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
        const result = yield* succeed({ ids: ["R1", "R2"], output: "/data/b.geojson" })
        expect(result.output).toContain("None of the 2 requested object(s) could be obtained")
        expect(result.output).not.toContain("Wrote")
        expect(result.metadata.error_code).toBe("NothingObtained")
        expect(result.metadata.failed).toBe(true)
      }),
    { timeout: 20_000 },
  )

  // A remark means the batch answered and a note means it did not, so the kernel never sets both; unheard, the
  // per-object fallback's troubles read as problems with the objects.
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
    // Read off the constant, so a changed kernel limit turns this red.
    expect(OBJECTS_DESCRIPTION).toContain(String(GeoOsm.MAX_IDS))
    expect(OBJECTS_DESCRIPTION).not.toMatch(/under about 10/)
  })

  test("it never points the model at metadata, which the model cannot see", () => {
    expect(OBJECTS_DESCRIPTION).not.toMatch(/metadata/i)
  })

  test("it leaves the verification discipline to the subagent that holds the permission", () => {
    expect(OBJECTS_DESCRIPTION).not.toMatch(/ReadGeoData/)
  })

  test("it warns about the wait", () => {
    expect(OBJECTS_DESCRIPTION).toContain("TIMING")
  })
})

describe("OsmGetObjects, saying so while it runs", () => {
  harness(
    osmService({
      downloadObjects: (input) =>
        Effect.gen(function* () {
          const report = input.onProgress as GeoOsm.OnProgress
          // Like the kernel: the batch settles two of four, then the fallback ticks through the rest.
          yield* report(2, 4)
          yield* report(3, 4)
          yield* report(4, 4)
          return DOWNLOAD()
        }),
    }),
  ).instance("the count reaches the caller, and it starts where the batch left off", () =>
    Effect.gen(function* () {
      const pushed = yield* pushesOf({ ids: ["W2", "N1", "R7", "W9"], output: "/data/objects.geojson" })

      // A kernel counting into a callback the tool never passed is what neither side sees alone.
      expect(pushed.map((entry) => entry.objects_settled)).toEqual([2, 3, 4])
      for (const entry of pushed) expect(entry.objects_asked).toBe(4)
    }),
  )
})
