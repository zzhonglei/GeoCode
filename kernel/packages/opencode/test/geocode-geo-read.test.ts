import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RASTER_MAIN, VECTOR_MAIN } from "@opencode-ai/core/filesystem/geo-extensions"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis, GeoRuntime } from "../src/geo"
import { QgisReader } from "../src/geo/qgis/reader"
import { InstanceState } from "../src/effect/instance-state"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { fitVectorPayload, RASTER_SUPPORTED, VECTOR_SUPPORTED } from "../src/tool/geo-read"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import READ_DESCRIPTION from "../src/tool/geo-read.txt"
import { testEffect } from "./lib/effect"

/* Tripwires for the geo tool registration (GEOKERNEL §10.1 #9; docs/TOOLS.md §7).
 *
 * The first test is also the layer-graph verdict: compiling the registry now
 * compiles GeoKernel behind it, so a dependency cycle or a double-mount would
 * fail HERE, not in a running server.
 *
 * The permission tests are behavioural on purpose: they run the tool's real
 * execute under the ruleset of the agent the assembly layer actually built,
 * so a mismatch between the key the tool asks with and the key the rules name
 * — the old version's exact accident (docs/KERNEL.md §4.1) — turns the test
 * red instead of silently never matching.
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

/** The tool's real execute, run under a given agent's ruleset. */
const executeAs = Effect.fnUntraced(function* (agentName: string, filePath: string) {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  expect(agent).toBeDefined()
  const georead = (yield* registry.all()).find((tool) => tool.id === "ReadGeoData")
  expect(georead).toBeDefined()

  return yield* georead!
    .execute(
      { filePath, mode: "metadata" },
      {
        sessionID: SessionID.make("ses_geo_read_test"),
        messageID: MessageID.make("msg_geo_read_test"),
        agent: agentName,
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req) =>
          permission
            .ask({ ...req, sessionID: SessionID.make("ses_geo_read_test"), ruleset: agent!.permission })
            .pipe(Effect.orDie),
      },
    )
    // Bounded so a counterproof cannot hang: with the global geo_* deny
    // removed, evaluate() falls back to "ask" and this call would wait for a
    // user who is not there.
    .pipe(Effect.timeout(5_000), Effect.exit)
})

describe("geo tool registration", () => {
  it.instance("ReadGeoData is in the registry", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("ReadGeoData")
    }),
  )

  it.instance("reading is granted to both the working agent and the planner", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "no-such-scene.tif")

      // Both get through, and the proof is the SHAPE of the failure: a call
      // that dies at the missing file has already passed the ask, which is the
      // only way to tell "the grant matched the key" from "the grant was
      // written and silently never consulted" (docs/KERNEL.md §4.1).
      //
      // plan is included deliberately. Upstream lets plan read files; reading
      // geographic data is the same act, and a planner that cannot look at the
      // data cannot plan work on it.
      for (const agent of ["GeoAgent", "plan"]) {
        const missed = yield* executeAs(agent, target)
        expect(Exit.isFailure(missed)).toBe(true)
        if (Exit.isFailure(missed)) {
          const cause = Cause.pretty(missed.cause)
          expect(cause).toContain("File not found")
          expect(cause).not.toContain("rule which prevents")
        }
      }
    }),
  )

  it.instance("an unconfigured environment answers with the kernel's guidance", () =>
    Effect.gen(function* () {
      // A real file this time, against an unconfigured kernel: the call passes
      // permission and lands on the gate, and what comes back must be the
      // kernel-authored guidance — including the absolute path of the file the
      // Agent is supposed to write.
      //
      // The precondition is enforced, not assumed: other files in this process
      // exercise the (process-global) kernel with real machine.json hints, so
      // relying on bun's file ordering to run first would make this test
      // hostage to a traversal detail. Delete the file and wait for the watcher
      // to settle the kernel back to unconfigured.
      fs.rmSync(path.join(Global.Path.config, "machine.json"), { force: true })
      const qgis = yield* GeoQgis.Service
      const deadline = Date.now() + 10_000
      let gate = yield* qgis.gate()
      while ((gate.ok || gate.status.status !== "unconfigured") && Date.now() < deadline) {
        yield* Effect.sleep(200)
        gate = yield* qgis.gate()
      }
      expect(!gate.ok && gate.status.status === "unconfigured").toBe(true)

      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "scene.asc")
      fs.writeFileSync(target, "ncols 1\nnrows 1\nxllcorner 0\nyllcorner 0\ncellsize 1\n0\n")

      const result = yield* executeAs("GeoAgent", target)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) {
        expect(result.value.metadata.error).toBe(true)
        expect(result.value.metadata.geoStatus).toBe("unconfigured")
        expect(result.value.output).toContain(path.join(Global.Path.config, "machine.json"))
        expect(result.value.output).toContain('"qgis"')
      }
    }),
  )

  test("the description prepares the Agent for the two endings it can produce", () => {
    // ReadGeoData returns the same cancellation banner RunQgisAlgorithm does
    // (both spawn), so it owes the reader the same warning: upstream completes
    // an aborted call with whatever the tool returns, and a model that reads a
    // cancellation as a failure will restart what the user just stopped.
    expect(READ_DESCRIPTION).toContain("cancelled was stopped by the user")
    expect(READ_DESCRIPTION).toContain("do not restart it on your own")
  })

  test("overflow drops features, never cuts the string", () => {
    const feature = (i: number) => ({ id: i, name: "x".repeat(2_000) })
    const build = (count: number) => ({
      driver: "GeoJSON",
      layer_index: 0,
      layer: { feature_count: 10_000, features: Array.from({ length: count }, (_, i) => feature(i)) },
    })

    // Under budget: untouched.
    const small = build(2)
    expect(fitVectorPayload(small, 50_000)).toEqual({ dropped: 0, fits: true })
    expect((small.layer.features as unknown[]).length).toBe(2)

    // Over budget: features are dropped from the tail until the SERIALIZED
    // payload fits — the result is a smaller honest sample, still valid JSON.
    const big = build(50)
    const fit = fitVectorPayload(big, 20_000)
    expect(fit.dropped).toBeGreaterThan(0)
    expect(fit.fits).toBe(true)
    expect((big.layer.features as unknown[]).length).toBeGreaterThan(0)
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(20_000)

    // Even the featureless payload can exceed the budget (a very wide
    // schema's statistics): report fits=false, ship honestly, cut nothing.
    const wide = {
      layer: { field_stats: "s".repeat(30_000), features: [feature(1)] },
    }
    const wideFit = fitVectorPayload(wide, 10_000)
    expect(wideFit.dropped).toBe(1)
    expect(wideFit.fits).toBe(false)

    // The budget is BYTES of the exact serialized string, not UTF-16 code
    // units: CJK attribute values count one for three, and Taiwanese data is
    // exactly this shape. 4000 chars ≈ 12000 bytes — a code-unit measure
    // would call this comfortably under a 10KB budget and drop nothing.
    const cjk = {
      layer: { feature_count: 2, features: [{ name: "漢".repeat(4_000) }, { name: "字".repeat(10) }] },
    }
    const cjkFit = fitVectorPayload(cjk, 10_000)
    expect(cjkFit.dropped).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(cjk), "utf-8")).toBeLessThanOrEqual(10_000)
  })

  it.instance("the supported formats stay a subset of the shared taxonomy", () =>
    Effect.gen(function* () {
      // The tool advertises what its reader scripts were validated against;
      // the taxonomy (injection point #5) names what counts as GIS data. The
      // first must never drift outside the second.
      for (const ext of VECTOR_SUPPORTED) expect(VECTOR_MAIN).toContain(ext)
      for (const ext of RASTER_SUPPORTED) expect(RASTER_MAIN).toContain(ext)
    }),
  )
})

/* A cancelled read, with the gate and the subprocess stood in for.
 *
 * Upstream does not interrupt a tool when the signal fires — it takes whatever
 * the tool returns and completes the call with it (session/tools.ts) — so what
 * comes back here is what the user and the model both see for the user's own
 * Esc. Reporting it as a broken read hands the model something to retry, and
 * hands the user a fault that never happened.
 */
describe("ReadGeoData, cancelled", () => {
  const cancelledRuntime = Layer.mock(GeoRuntime.Service)({
    run: () =>
      Effect.succeed({
        code: null,
        reason: "abort",
        stdout: "",
        stderr: "",
        durationMs: 3,
        truncated: false,
        drainIncomplete: false,
      } satisfies GeoRuntime.Result),
    killAllSync: () => {},
  })

  const openGate = Layer.succeed(
    GeoQgis.Service,
    GeoQgis.Service.of({
      gate: () =>
        Effect.succeed({
          ok: true,
          environment: {
            python: "/fake/python3.12",
            prefix: "/fake/prefix",
            env: {},
            dllDirectories: [],
            versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
            processing: true,
          },
        }),
    }),
  )

  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoQgis.node, openGate],
      [GeoRuntime.node, cancelledRuntime],
    ]),
  )

  it.instance("a data failure is attributed as one, not as an environment event", () =>
    Effect.gen(function* () {
      // `error: true` is the shut gate's signal and travels with geoStatus.
      // Reusing it for a script that could not parse a file would have a bad
      // GeoJSON render as an environment card — and leave the caller no way to
      // tell the two apart, which is exactly what the shared-shape tripwire in
      // geocode-qgis-run.test.ts assumes it can do.
      const registry = yield* ToolRegistry.Service
      const permission = yield* Permission.Service
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "broken.geojson")
      fs.writeFileSync(target, "{ not json")

      const georead = (yield* registry.all()).find((tool) => tool.id === "ReadGeoData")!
      const result = yield* georead
        .execute(
          { filePath: target, mode: "metadata" },
          {
            sessionID: SessionID.make("ses_geo_read_fail"),
            messageID: MessageID.make("msg_geo_read_fail"),
            agent: "GeoAgent",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (req) =>
              permission
                .ask({ ...req, sessionID: SessionID.make("ses_geo_read_fail"), ruleset: agent!.permission })
                .pipe(Effect.orDie),
          },
        )
        .pipe(Effect.timeout(10_000), Effect.exit)

      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) {
        expect(result.value.metadata.error_code).toBe("ReadFailed")
        expect(result.value.metadata.failed).toBe(true)
        expect("error" in result.value.metadata).toBe(false)
        expect("geoStatus" in result.value.metadata).toBe(false)
      }
    }),
  )

  it.instance("says the user cancelled, in the same words the other QGIS tools use", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const permission = yield* Permission.Service
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "cancelled.geojson")
      fs.writeFileSync(target, '{"type":"FeatureCollection","features":[]}')

      const controller = new AbortController()
      controller.abort()
      const georead = (yield* registry.all()).find((tool) => tool.id === "ReadGeoData")!
      const result = yield* georead
        .execute(
          { filePath: target, mode: "metadata" },
          {
            sessionID: SessionID.make("ses_geo_read_cancel"),
            messageID: MessageID.make("msg_geo_read_cancel"),
            agent: "GeoAgent",
            abort: controller.signal,
            messages: [],
            metadata: () => Effect.void,
            ask: (req) =>
              permission
                .ask({ ...req, sessionID: SessionID.make("ses_geo_read_cancel"), ruleset: agent!.permission })
                .pipe(Effect.orDie),
          },
        )
        .pipe(Effect.timeout(10_000), Effect.exit)

      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isSuccess(result)) {
        expect(result.value.output).toContain("User cancelled execution")
        expect(result.value.output).not.toContain("Read failed")
        expect(result.value.metadata.aborted).toBe(true)
      }
    }),
  )
})

/* A successful read, with the reader's subprocess stood in for.
 *
 * Two things the tool decides on top of the payload can only be checked with a
 * payload in hand, and both were half-wired against the reader script: which
 * formats may select a layer, and whether paging advice applies at all.
 */
describe("ReadGeoData, shaping a payload", () => {
  const spawned: { args: readonly string[] } = { args: [] }

  /** stdout the reader will accept: its marker followed by one JSON object. */
  const readerReturning = (payload: Record<string, unknown>) =>
    Layer.mock(GeoRuntime.Service)({
      run: (options) =>
        Effect.sync(() => {
          spawned.args = options.args ?? []
          return {
            code: 0,
            reason: "exit",
            stdout: `${QgisReader.MARKER}${JSON.stringify(payload)}\n`,
            stderr: "",
            durationMs: 4,
            truncated: false,
            drainIncomplete: false,
          } satisfies GeoRuntime.Result
        }),
      killAllSync: () => {},
    })

  /** Mixed geometry: sampled per type across the whole layer, offset ignored. */
  const MIXED = {
    driver: "GPX",
    layer_index: 0,
    layer: {
      data_type: "vector",
      feature_count: 900,
      crs_name: "WGS 84",
      geometry_types: { POINT: { count: 500 }, LINESTRING: { count: 400 } },
      features: Array.from({ length: 3 }, (_, i) => ({ id: i, blob: "y".repeat(30_000) })),
    },
  }

  const openGate = Layer.succeed(
    GeoQgis.Service,
    GeoQgis.Service.of({
      gate: () =>
        Effect.succeed({
          ok: true,
          environment: {
            python: "/fake/python3.12",
            prefix: "/fake/prefix",
            env: {},
            dllDirectories: [],
            versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
            processing: true,
          },
        }),
    }),
  )

  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoQgis.node, openGate],
      [GeoRuntime.node, readerReturning(MIXED)],
    ]),
  )

  it.instance("selects a layer on any multi-layer source, and pages only where paging exists", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const permission = yield* Permission.Service
      const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "track.gpx")
      fs.writeFileSync(target, "<gpx></gpx>")

      const georead = (yield* registry.all()).find((tool) => tool.id === "ReadGeoData")!
      const result = yield* georead.execute(
        { filePath: target, mode: "metadata", layerIndex: 2, limit: 3 },
        {
          sessionID: SessionID.make("ses_shape"),
          messageID: MessageID.make("msg_shape"),
          agent: "GeoAgent",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (req) =>
            permission
              .ask({ ...req, sessionID: SessionID.make("ses_shape"), ruleset: agent!.permission })
              .pipe(Effect.orDie),
        },
      )

      // The reader emits an overview for ANY driver with more than one layer,
      // so gating selection on .gpkg showed a .gpx's layers and gave no way to
      // reach past the first.
      expect(spawned.args).toContain("2")

      // And the paging advice: this layer mixes geometry types, which the
      // reader samples per type across the whole layer, ignoring offset. The
      // old advice sent the caller back for the features it already had.
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("mixes geometry types")
      expect(result.output).not.toContain("Continue with offset=")
    }),
  )
})

describe("ReadGeoData, and a raster that is only a picture", () => {
  const openGate = Layer.succeed(
    GeoQgis.Service,
    GeoQgis.Service.of({
      gate: () =>
        Effect.succeed({
          ok: true,
          environment: {
            python: "/fake/python3.12",
            prefix: "/fake/prefix",
            env: {},
            dllDirectories: [],
            versions: { python: "3.12.11", gdal: "3.12.0", qgis: "3.44.9" },
            processing: true,
          },
        }),
    }),
  )

  /** Nothing anywhere: the identity transform is GDAL's way of saying "none". */
  const NOTHING = { transform: [0, 1, 0, 0, 0, 1], projection: false, gcp_count: 0, rpc: false, geolocation: false }
  /** A raw satellite scene: no transform, no CRS, and unmistakably geographic. */
  const RAW_SCENE = { ...NOTHING, rpc: true }

  const runtimeSaying = (stdout: string) =>
    Layer.mock(GeoRuntime.Service)({
      run: () =>
        Effect.succeed({
          code: 0,
          reason: "exit",
          stdout,
          stderr: "",
          durationMs: 4,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result),
      killAllSync: () => {},
    })

  const call = (stdout: string, mode: "metadata" | "preview", name: string) => {
    const it = testEffect(
      LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [GeoQgis.node, openGate],
        [GeoRuntime.node, runtimeSaying(stdout)],
      ]),
    )
    return {
      it,
      body: () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const permission = yield* Permission.Service
          const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
          const ctx = yield* InstanceState.context
          const target = path.join(ctx.directory, `${name}.tif`)
          fs.writeFileSync(target, "pixels")
          const georead = (yield* registry.all()).find((tool) => tool.id === "ReadGeoData")!
          return yield* georead.execute(
            { filePath: target, mode },
            {
              sessionID: SessionID.make(`ses_${name}`),
              messageID: MessageID.make(`msg_${name}`),
              agent: "GeoAgent",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (req) =>
                permission
                  .ask({ ...req, sessionID: SessionID.make(`ses_${name}`), ruleset: agent!.permission })
                  .pipe(Effect.orDie),
            },
          )
        }),
    }
  }

  const marked = (payload: object) => `${QgisReader.MARKER}${JSON.stringify(payload)}\n`
  /** The preview protocol: marker line, then the image. Four characters encode three bytes. */
  const rendered = (meta: object) => `${marked({ width: 10, height: 10, bytes: 3, ...meta })}AAAA\n`

  {
    const { it, body } = call(
      marked({ data_type: "raster", georeferencing: NOTHING, size: { width: 1200, height: 900 }, band_count: 3 }),
      "metadata",
      "scan",
    )
    it.instance("metadata mode refuses it, and names what was looked for", () =>
      Effect.gen(function* () {
        const result = yield* body()
        expect(result.metadata.error_code).toBe("NotGeographic")
        expect(result.metadata.georeference).toBe("none")
        // Named, not summarized: "not geographic data" alone reads like a guess
        // about the file and invites a second attempt at the same one.
        for (const place of ["transform", "control points", "RPC", "geolocation", "coordinate system"]) {
          expect(result.output).toContain(place)
        }
        // And the metadata it did have does not leak out as if it were useful.
        expect(result.output).not.toContain("1200")
      }),
    )
  }

  {
    const { it, body } = call(rendered({ georeferencing: NOTHING }), "preview", "figure")
    it.instance("preview mode refuses it with the same sentence, not as a failed render", () =>
      Effect.gen(function* () {
        const result = yield* body()
        expect(result.metadata.error_code).toBe("NotGeographic")
        // One sentence, one judgement, two modes (GEOKERNEL §7.9) — the same
        // five places named above, and the same conclusion drawn from them.
        for (const place of ["transform", "control points", "RPC", "geolocation", "coordinate system"]) {
          expect(result.output).toContain(place)
        }
        expect(result.output).toContain("an image, not geographic data")
        expect(result.output).not.toContain("Preview failed")
        // No picture: refusing and then handing one over would be neither.
        expect(result.attachments).toBeUndefined()
      }),
    )
  }

  {
    const { it, body } = call(
      marked({ data_type: "raster", georeferencing: RAW_SCENE, size: { width: 30000, height: 30000 } }),
      "metadata",
      "scene",
    )
    it.instance("an unrectified scene is data, and the Agent is told which kind", () =>
      Effect.gen(function* () {
        const result = yield* body()
        expect(result.metadata.error_code).toBeUndefined()
        expect(result.metadata.georeference).toBe("rpc")
        // The five raw fields are replaced by what they add up to: `rpc` says
        // the extent below is still pixel indices, which is the part that acts.
        expect(result.output).toContain('"georeferencing":"rpc"')
        expect(result.output).not.toContain("gcp_count")
      }),
    )
  }

  {
    const { it, body } = call(rendered({ georeferencing: RAW_SCENE }), "preview", "raw")
    it.instance("and it is previewed like any other raster", () =>
      Effect.gen(function* () {
        const result = yield* body()
        expect(result.metadata.error_code).toBeUndefined()
        expect(result.attachments?.[0]?.mime).toBe("image/png")
      }),
    )
  }
})
