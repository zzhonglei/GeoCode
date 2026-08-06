import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis, GeoRuntime } from "../src/geo"
import { QgisCatalog } from "../src/geo/qgis/catalog"
import { InstanceState } from "../src/effect/instance-state"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { GeoTool } from "../src/tool/geo-tool"
import { PARAMETERS_LIMIT } from "../src/tool/geo-qgis-run"
import DOC_DESCRIPTION from "../src/tool/geo-qgis-doc.txt"
import READ_DESCRIPTION from "../src/tool/geo-read.txt"
import RUN_DESCRIPTION from "../src/tool/geo-qgis-run.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

/* Tripwires for RunQgisAlgorithm (docs/TOOLS.md §3; GEOKERNEL §4.12, §11.2).
 *
 * The ten return paths are the whole point of this tool, and every one of them
 * is reachable here without QGIS: the executor is a free function over
 * GeoRuntime.Interface, so a scripted runtime plus an open gate puts any
 * ending under test. A tool that only proves itself on the author's machine
 * proves nothing about the merge that breaks it.
 */

const ALGORITHM: QgisCatalog.Algorithm = {
  id: "native:buffer",
  name: "Buffer",
  group: "Vector geometry",
  description: "Computes a buffer.",
  helpText: "help",
  parameters: [
    { name: "INPUT", description: "in", type: "source", defaultValue: null, options: [], optional: false },
    // Non-optional AND defaulted: the shape 74% of the real catalog carries,
    // and the one that used to make a correct call raise alarms.
    { name: "SEGMENTS", description: "s", type: "number", defaultValue: "5", options: [], optional: false },
    { name: "DISSOLVE", description: "x", type: "boolean", defaultValue: "False", options: [], optional: false },
    { name: "DISTANCE", description: "d", type: "distance", defaultValue: "10", options: [], optional: true },
  ],
  outputs: [],
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

const stubCatalog = Layer.succeed(
  QgisCatalog.Service,
  QgisCatalog.Service.of({
    build: () => Effect.succeed({ ok: true as const }),
    invalidate: () => Effect.void,
    groups: () => Effect.succeed([]),
    inGroup: () => Effect.succeed([]),
    resolve: (id) =>
      Effect.succeed(
        id === "native:buffer" || id === "Buffer"
          ? { kind: "found" as const, algorithm: ALGORITHM }
          : { kind: "missing" as const },
      ),
    get: (id) => Effect.succeed(id === "native:buffer" || id === "Buffer" ? ALGORITHM : undefined),
    search: () => Effect.succeed([]),
    suggest: () => Effect.succeed(["native:buffer"]),
  }),
)

/** What the last scripted run was actually asked to execute. */
const spawned: { args: readonly string[] } = { args: [] }

/** A runtime whose single run() reports whatever ending the test asks for. */
function runtimeEnding(result: Partial<GeoRuntime.Result>, chunks: readonly string[] = []) {
  return Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.gen(function* () {
        spawned.args = options.args ?? []
        for (const chunk of chunks) {
          if (options.delivery.mode === "incremental") yield* options.delivery.onChunk(chunk)
        }
        return {
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 5,
          truncated: false,
          drainIncomplete: false,
          ...result,
        } satisfies GeoRuntime.Result
      }),
    killAllSync: () => {},
  })
}

const harness = (runtime: Layer.Layer<GeoRuntime.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoQgis.node, openGate],
      [QgisCatalog.node, stubCatalog],
      [GeoRuntime.node, runtime],
    ]),
  )

const execute = Effect.fnUntraced(function* (params: Record<string, unknown>, agentName = "GeoAgent") {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  const tool = (yield* registry.all()).find((item) => item.id === "RunQgisAlgorithm")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_run_test"),
      messageID: MessageID.make("msg_run_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_run_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(5_000), Effect.exit)
})

const succeed = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const result = yield* execute(params)
  expect(Exit.isSuccess(result)).toBe(true)
  if (!Exit.isSuccess(result)) throw new Error("refused")
  return result.value
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("RunQgisAlgorithm, pre-spawn refusals", () => {
  const it = harness(runtimeEnding({}))

  it.instance("is in the registry, and the boundary holds", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("RunQgisAlgorithm")

      // The wildcard GeoAgent carries is `geo_qgis_*`; the key this tool asks
      // with is `geo_qgis_run`. Only a behavioural check tells "the wildcard
      // covers it" from "it silently misses" (docs/KERNEL.md §4.1).
      const denied = yield* execute({ algorithm: "native:buffer", parameters: "{}" }, "plan")
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
    }),
  )

  it.instance(
    "a malformed tool call is blamed on the tool call, and never on QGIS",
    () =>
      Effect.gen(function* () {
        // The old build's lesson: a bare "Invalid parameters" reads as "QGIS
        // rejected me" and sends the model hunting for a bug that is not there.
        // Each refusal has to say QGIS was never invoked and whose fault it is.
        for (const parameters of ["not json", "[1,2]", '"a string"', "null"]) {
          const result = yield* succeed({ algorithm: "native:buffer", parameters })
          expect(result.output).toContain("QGIS was NOT invoked")
          expect(result.output).toContain("on your end (the agent)")
          expect(result.metadata.param_error).toBe(true)
          // No subprocess ran, so there is nothing to report a duration for.
          // A synthetic 0ms would tell the Agent the algorithm ran and finished.
          expect(result.output).not.toContain("Elapsed:")
          expect(result.metadata.elapsed_ms).toBeUndefined()
        }
      }),
    // Four executions behind a full kernel build, which lands close enough to
    // bun's five-second default to flake. A gate that fails at random teaches
    // people to re-run it rather than read it.
    { timeout: 20_000 },
  )

  it.instance("an over-long parameter string is refused where the cause is still known", () =>
    Effect.gen(function* () {
      // Past the OS command-line cap the spawn fails with nothing to attribute
      // it to, so the check happens here — and on BOTH platforms, or a call
      // that works on the author's Mac becomes the one that breaks on Windows.
      const parameters = JSON.stringify({ INPUT: "x".repeat(PARAMETERS_LIMIT) })
      expect(parameters.length).toBeGreaterThan(PARAMETERS_LIMIT)
      const result = yield* succeed({ algorithm: "native:buffer", parameters })
      expect(result.metadata.error_code).toBe("ParametersTooLong")
      expect(result.output).toContain("QGIS was NOT invoked")
      expect(result.output).not.toContain("Elapsed:")

      // One character under the limit gets through to the run.
      const ok = yield* succeed({
        algorithm: "native:buffer",
        parameters: JSON.stringify({ INPUT: "x".repeat(PARAMETERS_LIMIT - 40) }),
      })
      expect(ok.metadata.error_code).toBeUndefined()
      expect(ok.output).toContain("Elapsed:")
    }),
  )
})

describe("RunQgisAlgorithm, endings", () => {
  const ending = (result: Partial<GeoRuntime.Result>, chunks?: readonly string[]) =>
    harness(runtimeEnding(result, chunks))

  ending({ code: 0, reason: "exit" }, ["Algorithm name: Buffer\n", "Progress: 50%\n"]).instance(
    "a clean run reports its name, its output and its duration",
    () =>
      Effect.gen(function* () {
        // Every parameter supplied, so pre-flight genuinely has nothing to say.
        const result = yield* succeed({
          algorithm: "native:buffer",
          parameters: '{"INPUT":"/a.shp","SEGMENTS":5,"DISSOLVE":false,"DISTANCE":1}',
        })
        expect(result.title).toBe("Buffer")
        expect(result.metadata.display_name).toBe("Buffer")
        expect(result.metadata.exit_code).toBe(0)
        expect(result.output).toContain("Progress: 50%")
        expect(result.output).toContain("Elapsed:")
        // Nothing went wrong, so no banner claims otherwise.
        expect(result.output).not.toContain("---")
        expect(result.metadata.failed).toBeUndefined()
        // Pre-flight ran and had nothing to say: present, and empty. An absent
        // field is reserved for "never got that far".
        expect(result.metadata.precheck).toEqual([])
      }),
  )

  ending({ code: null, reason: "abort" }, ["Progress: 20%\n"]).instance(
    "a cancelled run keeps what it produced and says it was cancelled",
    () =>
      Effect.gen(function* () {
        // Upstream completes the tool call with whatever comes back, so this
        // text is what the user and the model both see for their own Esc.
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.output).toContain("Progress: 20%")
        expect(result.output).toContain("User cancelled execution")
        expect(result.output).not.toContain("failed")
        expect(result.metadata.aborted).toBe(true)
        expect(result.metadata.partial).toBe(true)
        expect(result.output).toContain("Elapsed:")
      }),
  )

  ending({ code: null, reason: "idle" }).instance("an idle timeout names the number it hit", () =>
    Effect.gen(function* () {
      // The fix for this ending IS a number. "It went quiet for too long"
      // without saying how long leaves the caller with nothing to raise.
      const result = yield* succeed({
        algorithm: "native:buffer",
        parameters: '{"INPUT":"/a.shp"}',
        timeout: 45,
      })
      expect(result.output).toContain("--- timeout ---")
      expect(result.output).toContain("45s")
      expect(result.output).toContain("raise `timeout`")
      expect(result.metadata.idle_limit_seconds).toBe(45)
      expect(result.metadata.timed_out).toBe(true)
      expect(result.metadata.error_code).toBe("IdleTimeout")
    }),
  )

  ending({ code: 0, reason: "exit" }).instance("a parameter finding says where to look it up", () =>
    Effect.gen(function* () {
      // The old build appended this to every parameter-level warning. Telling
      // the model what is wrong with no next step is half an answer, and the
      // runner script deliberately stopped naming tools (§11.2), so the
      // pointer has to come from here.
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"NOPE":1}' })
      expect(result.output).toContain("is not defined for")
      expect(result.output).toContain('QgisDoc with action="read", algorithm="native:buffer"')

      // A run with nothing wrong gets no pointer — it would be noise, and
      // noise is what made pre-flight ignorable in the first place.
      const clean = yield* succeed({
        algorithm: "native:buffer",
        parameters: '{"INPUT":"/a.shp","SEGMENTS":5,"DISSOLVE":false,"DISTANCE":1}',
      })
      expect(clean.output).not.toContain("QgisDoc")
    }),
  )

  ending({ code: 0, reason: "exit" }, [`${"z".repeat(40_000)}\n`, "tail-line\n"]).instance(
    "a trimmed live view says it was trimmed",
    () =>
      Effect.gen(function* () {
        // The live push keeps the tail, which is where a running algorithm says
        // anything new; dropping the head silently would let a watcher read a
        // partial log as the whole one. Nothing here touches the final result.
        const pushes: { truncated: unknown; output: unknown }[] = []
        const registry = yield* ToolRegistry.Service
        const permission = yield* Permission.Service
        const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
        const tool = (yield* registry.all()).find((item) => item.id === "RunQgisAlgorithm")!
        const result = yield* tool.execute(
          { algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' },
          {
            sessionID: SessionID.make("ses_stream"),
            messageID: MessageID.make("msg_stream"),
            agent: "GeoAgent",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: (input) =>
              Effect.sync(() => {
                if (input.metadata) pushes.push(input.metadata as never)
              }),
            ask: (req) =>
              permission
                .ask({ ...req, sessionID: SessionID.make("ses_stream"), ruleset: agent!.permission })
                .pipe(Effect.orDie),
          },
        )
        const last = pushes[pushes.length - 1]!
        expect(last.truncated).toBe(true)
        expect(String(last.output)).toContain("earlier output trimmed")
        expect(String(last.output)).toContain("tail-line")
        // The final result is a different payload and answers for itself.
        expect(result.metadata.truncated).toBe(false)
      }),
  )

  ending({ code: null, reason: "crash", stderr: "Fatal Python error: Segmentation fault" }).instance(
    "a crash carries the native trace and explains the OS dialog",
    () =>
      Effect.gen(function* () {
        // The macOS crash reporter puts a dialog in front of the user seconds
        // after the tool already returned; without this the Agent cannot tell
        // them it is safe to dismiss.
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.output).toContain("Segmentation fault")
        expect(result.output).toContain("safe to dismiss")
        // This renderer is shared with GEE, which runs its own Python: naming
        // one capability here would have the other's crashes blame software
        // the user never invoked.
        expect(result.output).not.toContain("QGIS interpreter")
        expect(result.metadata.error_code).toBe("Crashed")
      }),
  )

  ending({ code: 1, reason: "exit", stderr: '{"error": "Layer /a.shp is not valid"}' }).instance(
    "a failing algorithm shows its own error, not the traceback around it",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.output).toContain("Layer /a.shp is not valid")
        expect(result.metadata.exit_code).toBe(1)
        expect(result.metadata.failed).toBe(true)
      }),
  )

  ending({ code: 0, reason: "exit" }).instance("an unknown algorithm is advised, never blocked", () =>
    Effect.gen(function* () {
      // Pre-flight advises and never vetoes (§4.12): the exported metadata
      // cannot express every constraint, and blocking on its gaps would turn
      // them into "the user cannot run this".
      const result = yield* succeed({ algorithm: "native:nosuch", parameters: '{"INPUT":"/a.shp"}' })
      expect(result.output).toContain("is not in the catalog")
      expect(result.output).toContain("native:buffer") // the nearest, wired by this layer
      expect(result.output).toContain('QgisDoc with action="search"') // the pointer the script dropped
      expect(result.output).toContain("Elapsed:") // it still ran
    }),
  )

  ending({ code: 0, reason: "exit" }).instance("a missing required parameter is reported before the spawn", () =>
    Effect.gen(function* () {
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"DISTANCE":5}' })
      expect(result.output).toContain("Pre-flight:")
      expect(result.output).toContain("INPUT")
      expect((result.metadata.precheck as unknown[]).length).toBeGreaterThan(0)
    }),
  )

  ending({ code: 0, reason: "exit" }).instance("a correct call is told what defaults apply, and not warned", () =>
    Effect.gen(function* () {
      // Supplying exactly the parameters that have no default IS a correct
      // call. It used to draw one alarm per defaulted parameter — up to twelve
      // on the real catalog — which trains a reader to skip pre-flight
      // entirely, and pre-flight is the only thing standing between a bad
      // parameter set and the user's disk.
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
      const kinds = (result.metadata.precheck as { kind: string }[]).map((hint) => hint.kind)
      expect(kinds).toEqual(["defaults-applied"])
      expect(result.output).not.toContain("is missing")

      // One line, and it carries the values the run will actually use.
      const lines = result.output.split("\n").filter((line) => line.startsWith("Pre-flight:"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("SEGMENTS=5")
      expect(lines[0]).toContain("DISSOLVE=False")
    }),
  )

  ending({ code: 0, reason: "exit" }).instance("QGIS is handed the canonical id, not the caller's spelling", () =>
    Effect.gen(function* () {
      // Lookup tolerates display names and short forms (§4.11); QGIS resolves
      // full ids only. Passing the raw key through would let a call clear
      // pre-flight and then fail inside the interpreter with nothing to
      // explain it — the mismatch §11.2 leaves to this layer to close.
      const result = yield* succeed({ algorithm: "Buffer", parameters: '{"INPUT":"/a.shp"}' })
      expect(spawned.args).toContain("native:buffer")
      expect(spawned.args).not.toContain("Buffer")
      expect(result.metadata.resolved_algorithm).toBe("native:buffer")
      // ...while metadata still records what the caller actually asked for.
      expect(result.metadata.algorithm).toBe("Buffer")
    }),
  )

  ending({ code: 0, reason: "exit" }, ["Progress: 10%\n", "Results: {'OUTPUT': '/out.gpkg'}\n"]).instance(
    "the tool always answers for its own size, so nothing upstream cuts the tail",
    () =>
      Effect.gen(function* () {
        // An algorithm's result does not scale with the user's data: Processing
        // writes per-feature findings into output LAYERS and keeps the feedback
        // log for progress and a summary. Saying `truncated` out loud is still
        // required — it is what stops tool.ts:131 running the generic
        // head-truncation, which keeps the head and drops the tail, and the
        // tail is where the ending and the footer live.
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.truncated).toBeDefined()
        // Both ends present: what ran it, and how it ended.
        expect(result.output).toContain("Results:")
        expect(result.output).toContain("Elapsed:")
      }),
  )
})

describe("RunQgisAlgorithm, shapes", () => {
  test("every ending has a banner, and only success has none", () => {
    // Six reasons, six distinct openings — a shared or missing one means an
    // ending arrives as another ending.
    const reasons = ["abort", "idle", "timeout", "crash", "output-limit"] as const
    const banners = reasons.map((reason) => GeoTool.terminationBanner(reason, "detail"))
    expect(new Set(banners).size).toBe(reasons.length)
    for (const banner of banners) expect(banner.startsWith("---")).toBe(true)

    expect(GeoTool.terminationBanner("abort")).toContain("User cancelled")
    expect(GeoTool.terminationBanner("exit", "boom")).toContain("boom")
    // A clean exit has nothing to announce.
    expect(GeoTool.terminationBanner("exit")).toBe("")
  })

  test("the elapsed footer uses the kernel's one duration format", () => {
    // Not a second implementation: the kernel keeps one form across every
    // module, and a private copy here is exactly the drift that prevents.
    expect(GeoTool.elapsedFooter(500)).toBe("Elapsed: 500ms")
    expect(GeoTool.elapsedFooter(1_500)).toBe("Elapsed: 1.5s")
    expect(GeoTool.elapsedFooter(90_000)).toBe("Elapsed: 1m30s")
  })

  test("the QGIS group speaks with one voice about its environment", () => {
    // Three tools, one gate, one guidance — so one sentence preparing the
    // Agent for it. The failure mode is silent: one file gets edited and the
    // Agent's behaviour depends on which tool it happened to call first.
    const shared =
      "This tool needs the user's QGIS environment. When that environment is not ready, the output says exactly what is missing and who can fix it — relay that to the user instead of retrying."
    for (const description of [READ_DESCRIPTION, DOC_DESCRIPTION, RUN_DESCRIPTION]) {
      expect(description).toContain(shared)
    }

    // The geographic doctrine that keeps a silently-wrong result from being
    // written to the user's disk. Losing it costs nothing visible, which is
    // exactly why it needs pinning.
    expect(RUN_DESCRIPTION).toContain("a 500m buffer becomes 500 degrees")
    expect(RUN_DESCRIPTION).toContain("MUST use QgisDoc")
    expect(RUN_DESCRIPTION).toContain("GeoJSON output MUST be in WGS-84")
  })
})

describe("the QGIS group's shut-gate answer", () => {
  const shutGate = Layer.succeed(
    GeoQgis.Service,
    GeoQgis.Service.of({ gate: () => Effect.succeed({ ok: false, status: { status: "unconfigured" } }) }),
  )

  const it = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeoQgis.node, shutGate],
      [QgisCatalog.node, stubCatalog],
      [GeoRuntime.node, runtimeEnding({})],
    ]),
  )

  it.instance(
    "carries the same fields from all three tools",
    () =>
      Effect.gen(function* () {
        // One voice is not only about wording. A shut gate is ONE event, and a
        // caller forced to learn three field sets will end up handling whichever
        // tool it happened to meet first.
        const registry = yield* ToolRegistry.Service
        const permission = yield* Permission.Service
        const agent = yield* Agent.Service.use((svc) => svc.get("GeoAgent"))
        const instance = yield* InstanceState.context
        const tools = yield* registry.all()

        const scene = path.join(instance.directory, "shut.geojson")
        fs.writeFileSync(scene, '{"type":"FeatureCollection","features":[]}')

        const shut = Effect.fnUntraced(function* (id: string, params: Record<string, unknown>) {
          const tool = tools.find((item) => item.id === id)!
          return yield* tool
            .execute(params, {
              sessionID: SessionID.make("ses_shut"),
              messageID: MessageID.make("msg_shut"),
              agent: "GeoAgent",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (req) =>
                permission
                  .ask({ ...req, sessionID: SessionID.make("ses_shut"), ruleset: agent!.permission })
                  .pipe(Effect.orDie),
            })
            .pipe(Effect.timeout(10_000))
        })

        const answers = [
          yield* shut("ReadGeoData", { filePath: scene, mode: "metadata" }),
          yield* shut("QgisDoc", { action: "list_groups" }),
          yield* shut("RunQgisAlgorithm", { algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' }),
        ]

        for (const answer of answers) {
          // The shared trio. Each tool may add its own subject on top — the file,
          // the algorithm — but recognising the event must never depend on which
          // tool produced it.
          expect(answer.metadata.error).toBe(true)
          expect(answer.metadata.geoStatus).toBe("unconfigured")
          expect(answer.metadata.truncated).toBe(false)
          // And the guidance itself is the kernel's, identical across all three.
          expect(answer.output).toContain("machine.json")
          // No synonym for `error`: a second flag meaning the same thing is how
          // three tools start meaning three different things by one event.
          expect("env_error" in answer.metadata).toBe(false)
        }
      }),
    { timeout: 20_000 },
  )

  test("a shut gate on a READY environment still names its cause", () => {
    // The gate wants ready AND processing AND a built catalog (§4.9), so it
    // refuses three shapes whose status name is `ready`. Reporting the bare
    // name there puts `error: true` next to `geoStatus: "ready"` in front of a
    // caller — a contradiction that names no cause, with the reason reachable
    // only by reading the prose.
    expect(GeoTool.gateStatus({ status: "unconfigured" })).toBe("unconfigured")
    expect(GeoTool.gateStatus({ status: "ready", processing: true, catalog: "ready" } as never)).toBe("ready")
    const refused = [
      { status: "ready", processing: false, catalog: "skipped" },
      { status: "ready", processing: true, catalog: "building" },
      { status: "ready", processing: true, catalog: "failed" },
    ] as const
    const labels = refused.map((status) => GeoTool.gateStatus(status as never))
    for (const label of labels) expect(label).not.toBe("ready")
    // Three refusals, three distinguishable labels — one shared label would
    // just move the ambiguity rather than remove it.
    expect(new Set(labels).size).toBe(refused.length)
  })
})
