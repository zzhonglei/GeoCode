import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RASTER_MAIN, VECTOR_MAIN } from "@opencode-ai/core/filesystem/geo-extensions"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis } from "../src/geo"
import { InstanceState } from "../src/effect/instance-state"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { fitVectorPayload, RASTER_SUPPORTED, VECTOR_SUPPORTED } from "../src/tool/geo-read"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
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
        ask: (req) => permission.ask({ ...req, sessionID: SessionID.make("ses_geo_read_test"), ruleset: agent!.permission }).pipe(Effect.orDie),
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

  it.instance("the boundary holds: plan is refused, GeoAgent gets through", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const target = path.join(ctx.directory, "no-such-scene.tif")

      // plan has no geo grant, so the global "geo_*": "deny" is the last
      // matching rule — the ask dies as a rule denial before the tool reveals
      // anything about the file.
      const denied = yield* executeAs("plan", target)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) {
        expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
      }

      // GeoAgent's "geo_qgis_*": "allow" merges after the global deny, so the
      // same call passes the ask and fails honestly at the missing file — the
      // proof that the allow actually matched the key the tool asks with.
      const missed = yield* executeAs("GeoAgent", target)
      expect(Exit.isFailure(missed)).toBe(true)
      if (Exit.isFailure(missed)) {
        const cause = Cause.pretty(missed.cause)
        expect(cause).toContain("File not found")
        expect(cause).not.toContain("rule which prevents")
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
