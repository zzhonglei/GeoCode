import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
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
import { PARAMETERS_LIMIT, describeCall } from "../src/tool/geo-qgis-run"
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

/* An algorithm that WRITES, which the buffer fixture above deliberately is not.
 *
 * Its OUTPUT carries the shape a real destination carries: non-optional, with
 * `TEMPORARY_OUTPUT` as the default, and `type: "sink"` — the commonest of the
 * six the catalog uses for something the algorithm produces (§4.12). */
const WRITER: QgisCatalog.Algorithm = {
  id: "native:writeout",
  name: "Write Out",
  group: "Vector geometry",
  description: "Writes a layer.",
  helpText: "help",
  parameters: [
    { name: "INPUT", description: "in", type: "source", defaultValue: null, options: [], optional: false },
    {
      name: "OUTPUT",
      description: "out",
      type: "sink",
      defaultValue: "TEMPORARY_OUTPUT",
      options: [],
      optional: false,
    },
  ],
  outputs: [],
}

/* The shape of `native:package` and `native:savefeatures`: a destination, plus
 * the algorithm's OWN parameter for a file that is already there. Three
 * algorithms in a real 3.44 catalog carry one, and for them an existing target
 * is the point of the call — numbering it appends to a new empty file and
 * reports success. */
const PACKAGER: QgisCatalog.Algorithm = {
  ...WRITER,
  id: "native:packager",
  name: "Package",
  parameters: [
    WRITER.parameters[0]!,
    { name: "OUTPUT", description: "out", type: "fileDestination", defaultValue: null, options: [], optional: false },
    {
      name: "OVERWRITE",
      description: "Overwrite existing spreadsheet",
      type: "boolean",
      defaultValue: "false",
      options: [],
      optional: true,
    },
  ],
}

/* No folder-destination fixture here any more, and that is not an oversight.
 * The tool layer used to treat one specially — `assertExternalDirectoryEffect`
 * scoped the grant to the folder itself rather than its parent — and that call
 * is gone (see "one prompt, wherever the output goes"). What remains of folder
 * behaviour lives entirely in `qgis/destination.ts` (never numbered, parent
 * created rather than leaf) and is tested there, in geo/qgis-destination.ts. */
const CATALOG = [ALGORITHM, WRITER, PACKAGER]

const known = (id: string) => (id === "Buffer" ? ALGORITHM : CATALOG.find((algorithm) => algorithm.id === id))

const stubCatalog = Layer.succeed(
  QgisCatalog.Service,
  QgisCatalog.Service.of({
    build: () => Effect.succeed({ ok: true as const }),
    invalidate: () => Effect.void,
    groups: () => Effect.succeed([]),
    inGroup: () => Effect.succeed([]),
    resolve: (id) => {
      const found = known(id)
      return Effect.succeed(found ? { kind: "found" as const, algorithm: found } : { kind: "missing" as const })
    },
    get: (id) => Effect.succeed(known(id)),
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

/**
 * A runtime that leaves files behind, the way a real algorithm does.
 *
 * The mock above writes nothing, which answers every question about what was
 * SENT and none about what is THERE. Only the second kind can catch the tool
 * reporting a reserved path instead of the file that exists — QGIS names the
 * output itself when the extension it was handed means nothing to it, and a
 * caller told to use the path from the report cannot use one that was never
 * written.
 */
function runtimeWriting(files: () => readonly string[]) {
  return Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.gen(function* () {
        spawned.args = options.args ?? []
        for (const file of files()) fs.writeFileSync(file, "written by the algorithm")
        return {
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 5,
          truncated: false,
          drainIncomplete: false,
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

/**
 * A user who has already approved the group, standing in.
 *
 * `qgis` is `ask` for GeoAgent, which is the whole point of the design — but
 * almost every test in this file is about what the tool DOES once it is allowed
 * to run. Without this the engine parks each one at an unanswered prompt until
 * its timeout, and they all fail for the single reason none of them is testing.
 *
 * Appended LAST on purpose: `evaluate` takes the last matching rule, so this is
 * the exact shape a real approval takes when the user answers "always"
 * (permission/index.ts pushes onto the same ruleset). The verdict itself — that
 * GeoAgent is asked at all — is asserted in geocode-geo-permissions.test.ts,
 * which can read it without anyone having to answer.
 */
const GRANTED = { permission: "qgis", pattern: "*", action: "allow" } as const

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
          .ask({ ...req, sessionID: SessionID.make("ses_run_test"), ruleset: [...agent!.permission, GRANTED] })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(5_000), Effect.exit)
})

/**
 * Run the tool with every permission granted, recording what it asked for.
 *
 * The engine's VERDICT for a key belongs to geocode-geo-permissions.test.ts,
 * which can read it without a user sitting there to answer. What can only be
 * seen from here is the other half — that the tool asks at all, with the key
 * and the path it should. A grant that is never requested and a request that is
 * never granted look identical from either side alone.
 */
const asksOf = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.all()).find((item) => item.id === "RunQgisAlgorithm")
  expect(tool).toBeDefined()
  const asked: { permission: string; patterns?: readonly string[] }[] = []
  const result = yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_ask_test"),
      messageID: MessageID.make("msg_ask_test"),
      agent: "GeoAgent",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        Effect.sync(() => {
          asked.push({ permission: req.permission, patterns: req.patterns })
        }),
    })
    .pipe(Effect.timeout(5_000), Effect.exit)
  expect(Exit.isSuccess(result)).toBe(true)
  return asked
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

      // GeoAgent holds `qgis`, which is the key this tool asks with. Only a
      // behavioural check tells "the grant matched" from "the grant was
      // written and silently missed" (docs/KERNEL.md §4.1).
      //
      // plan's side of this — asked rather than refused, so the tool stays
      // visible to a planner — is a fact about the ruleset and is pinned in
      // geocode-geo-permissions.test.ts, where it can be read without a user
      // sitting there to answer the prompt.
      const allowed = yield* execute({ algorithm: "native:buffer", parameters: "{}" })
      expect(Exit.isSuccess(allowed)).toBe(true)
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

  harness(
    Layer.mock(GeoRuntime.Service)({
      run: () => Effect.fail(new Error("spawn /gone/QGIS.app/Contents/MacOS/bin/python3 ENOENT")),
      killAllSync: () => {},
    }),
  ).instance("a launch that never happened is not reported as a crash", () =>
    Effect.gen(function* () {
      // The gate passed moments ago, so this is something that changed
      // underneath it — a moved installation, or an unwritable cache. Filing it
      // as `crash` told the agent a native library segfaulted below the Python
      // level and could not be caught, and gave a duration for a process that
      // never existed.
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
      expect(result.output).toContain("never ran")
      expect(result.output).toContain("ENOENT")
      expect(result.output).not.toContain("segfault")
      expect(result.output).not.toContain("Elapsed:")
      expect(result.metadata.elapsed_ms).toBeUndefined()
      expect(result.metadata.error_code).toBe("LaunchFailed")
    }),
  )

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
                .ask({ ...req, sessionID: SessionID.make("ses_stream"), ruleset: [...agent!.permission, GRANTED] })
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

    // The one behaviour that makes the tool answer with a path the caller did
    // not ask for. An agent that does not know this chains its next step onto
    // the name it requested and reads a file that was never written — which is
    // worse than the overwrite the numbering exists to prevent, because it
    // fails silently against stale data.
    expect(RUN_DESCRIPTION).toContain('"out.shp" becomes "out (1).shp"')
    expect(RUN_DESCRIPTION).toContain("Use that path for the next step")

    /* And the limits of that promise, which are the part a description drifts
     * away from first.
     *
     * This sentence used to read "Existing files are never overwritten" — an
     * unconditional claim in front of a conditional guarantee, which is the one
     * kind of sentence §七 rules out outright, because the agent acts on it.
     * Both exceptions are real: three catalogued algorithms carry their own
     * parameter for a pre-existing file, and a directory output is written into
     * as it stands. Pinned by their consequences rather than by phrasing, so
     * the wording stays free to improve.
     */
    expect(RUN_DESCRIPTION).not.toContain("never overwritten")
    expect(RUN_DESCRIPTION).toContain("OVERWRITE")
    expect(RUN_DESCRIPTION).toContain("ACTION_ON_EXISTING_FILE")
    expect(RUN_DESCRIPTION).toMatch(/directory is written into as it stands/i)
    // The mistake that puts a caller in the renaming case in the first place.
    expect(RUN_DESCRIPTION).toMatch(/give every output a real extension/i)
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
                  .ask({ ...req, sessionID: SessionID.make("ses_shut"), ruleset: [...agent!.permission, GRANTED] })
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

describe("RunQgisAlgorithm, where the output lands", () => {
  /* The tool that writes, guarded at the only point that can guard it.
   *
   * Undo does not reach geographic data — it is outside the checkpoint
   * mechanism by design (§10.1 #6), so a scene written over is gone with
   * nothing to restore it from. `qgis/destination.ts` owns the rule and is
   * tested on its own; what is asserted HERE is the wiring, because a correct
   * rule computed and then not passed on protects nothing at all.
   *
   * Outputs are placed inside the instance directory throughout, which is where
   * the agent's own instructions put them — but the permission prompt is pinned
   * for both placements, because "one prompt regardless of where the output
   * goes" is the decision this tool now rests on (docs/TOOLS.md §4.3).
   */
  const it = harness(runtimeEnding({}))

  /**
   * The parameters the runner was actually handed, decoded.
   *
   * `runScript` builds `["-c", <wrapped script>, <algorithm>, <parameters>]`
   * (executor.ts), so the payload is the last argument — read that way rather
   * than by index, since the bootstrap wrapper's shape is not this file's
   * business.
   */
  const sentParameters = (): Record<string, unknown> => JSON.parse(spawned.args.at(-1)!)

  it.instance("a taken output is re-pointed BEFORE the run, not merely reported after", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "out.shp")
      fs.writeFileSync(asked, "the earlier result")

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      // THE assertion. Reporting a new path while running with the old one is
      // exactly the failure that looks fine in every test that only reads the
      // prose, and it destroys the file anyway.
      const expected = path.join(instance.directory, "out (1).shp")
      expect(sentParameters().OUTPUT).toBe(expected)
      expect(sentParameters().OUTPUT).not.toBe(asked)
      // And the run really did go through, so this is not passing on a refusal.
      expect(result.metadata.error_code).toBeUndefined()
      // Untouched on disk: the mocked runtime writes nothing, so what this can
      // still show is that nothing on OUR side removed or rewrote it.
      expect(fs.readFileSync(asked, "utf8")).toBe("the earlier result")
    }),
  )

  it.instance("the caller is told the real path, and that its earlier file survived", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "scene.tif")
      fs.writeFileSync(asked, "first")

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      expect(result.output).toContain(path.join(instance.directory, "scene (1).tif"))
      expect(result.output).toContain("untouched")
      // The structured channel carries every recognised output, moved or not —
      // a frontend offering "open the result" never parses prose (§9.1).
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "scene (1).tif") },
      ])
    }),
  )

  it.instance("an untaken output is passed through and never mentioned", () =>
    Effect.gen(function* () {
      // A note that fires on every run is the noise that gets the channel
      // skipped. Nothing moved, so there is nothing to say.
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "fresh.shp")

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      expect(sentParameters().OUTPUT).toBe(asked)
      expect(result.output).not.toContain("already existed")
    }),
  )

  it.instance("an INPUT that happens to name an existing file is never re-pointed", () =>
    Effect.gen(function* () {
      /* The restraint half, end to end.
       *
       * §4.12 lets a metadata check ADVISE; re-pointing is stronger than that,
       * so it is fenced on the catalog calling the parameter a destination.
       * Renaming an input would send the algorithm to read a file that does not
       * exist — a correct call broken by the thing meant to protect it. */
      const instance = yield* InstanceState.context
      const input = path.join(instance.directory, "in.shp")
      fs.writeFileSync(input, "source data")

      yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: input, OUTPUT: path.join(instance.directory, "out.shp") }),
      })

      expect(sentParameters().INPUT).toBe(input)
    }),
  )

  it.instance("one prompt, wherever the output goes", () =>
    Effect.gen(function* () {
      /* ONE. This tool used to raise a second `external_directory` ask for
       * targets outside the working directory, the way `read`, `write` and
       * `bash` each do, and it was removed deliberately (docs/TOOLS.md §4.3):
       * that prompt could only ever see what `QgisDestination.reserve` sees,
       * and reserve is blind to 56 of 422 algorithms in a real registry — so it
       * charged the ordinary case a second dialog while staying silent for the
       * dangerous one. What replaced it is the prompt below, which carries the
       * whole call.
       *
       * Asserted for BOTH placements in one test on purpose. Split apart, a
       * change that re-introduced a second ask for outside targets only would
       * leave the inside case green, and green is what gets read as covered. */
      const instance = yield* InstanceState.context
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-outside-"))
      try {
        for (const target of [path.join(instance.directory, "results", "out.shp"), path.join(outside, "out.shp")]) {
          const asked = yield* asksOf({
            algorithm: "native:writeout",
            parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: target }),
          })
          expect(asked.map((item) => item.permission)).toEqual(["qgis"])
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    }),
  )

  it.instance("the prompt names the algorithm AND every path it was given", () =>
    Effect.gen(function* () {
      /* The whole design rests on this one string. With a second boundary ask
       * gone, what the user is shown here is the only thing standing between
       * the model and an in-place overwrite of data undo cannot restore — so it
       * has to say more than "an algorithm ran".
       *
       * Three separate ways to lose it, one assertion each below:
       *
       * - passing `[params.algorithm]` again (what this used to do) drops the
       *   paths entirely — `native:truncatetable` without saying to WHAT;
       * - normalising paths to a worktree-relative form, which is right for
       *   OSM's writer because it aligns with `write`, hides the one fact this
       *   prompt exists to reveal: that the target is outside the workspace;
       * - dropping parameters that are not paths would hide `BURN=99` on
       *   `gdal:rasterize_over` — a value burnt into an existing raster. */
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-outside-"))
      try {
        const target = path.join(outside, "out.shp")
        const asked = yield* asksOf({
          algorithm: "native:writeout",
          parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: target, DISTANCE: 100 }),
        })
        const pattern = asked[0]!.patterns![0]!
        expect(pattern).toContain("native:writeout")
        // Absolute and verbatim — `toContain` on the full path fails for any
        // relative form, which is the mutation worth catching.
        expect(pattern).toContain(target)
        expect(path.isAbsolute(target)).toBe(true)
        expect(pattern).toContain("/data/in.shp")
        expect(pattern).toContain("DISTANCE=100")
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    }),
  )

  it.instance("an algorithm the catalog does not know has every parameter left alone", () =>
    Effect.gen(function* () {
      // No metadata, no way to tell a destination from any other string. The
      // call still runs — §4.12 forbids blocking on what the catalog cannot
      // express — it just runs with exactly what it was given.
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "unknown.shp")
      fs.writeFileSync(asked, "existing")

      yield* succeed({
        algorithm: "native:notinthecatalog",
        parameters: JSON.stringify({ OUTPUT: asked }),
      })

      expect(sentParameters().OUTPUT).toBe(asked)
    }),
  )
})

describe("RunQgisAlgorithm, a run that failed points at no file", () => {
  const it = harness(runtimeEnding({ code: 1, stderr: "Error: algorithm failed" }))

  it.instance("no path is claimed for a run that wrote nothing", () =>
    Effect.gen(function* () {
      // The re-point happens before the spawn, so the sentence exists whether
      // or not the run succeeds. Printing it for a failure sends the caller
      // looking for a file that was never created.
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "out.shp")
      fs.writeFileSync(asked, "the earlier result")

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      expect(result.metadata.failed).toBe(true)
      expect(result.output).not.toContain("already existed")
      expect(result.output).not.toContain("out (1).shp")
      // Still recorded structurally: the frontend may want to show what the run
      // was aiming at, and it can read `failed` beside it.
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "out (1).shp") },
      ])
    }),
  )
})

describe("RunQgisAlgorithm, the path the caller is sent to", () => {
  /* The two cases where the reserved path is NOT the answer, wired end to end.
   *
   * Both are computed in `qgis/destination.ts` and tested there. What can only
   * be seen from here is whether this tool passes them on — the failure that
   * has come up more than any other in this codebase is a rule that is correct
   * on one side, consumed on neither, and green on both.
   *
   * These need a runtime that actually writes, because both questions are about
   * what is on disk when the run is over. */
  let writes: readonly string[] = []
  const it = harness(runtimeWriting(() => writes))
  const sentParameters = (): Record<string, unknown> => JSON.parse(spawned.args.at(-1)!)

  it.instance("the file QGIS named for itself is the one reported, not the one reserved", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "result")
      writes = [path.join(instance.directory, "result.gpkg")]

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      // What was SENT is untouched: this tool does not predict formats, and the
      // renaming is QGIS's.
      expect(sentParameters().OUTPUT).toBe(asked)
      // What is REPORTED is what exists. The caller is told to use this path for
      // its next step, and `/…/result` is not openable.
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "result.gpkg") },
      ])
      expect(result.output).toContain(path.join(instance.directory, "result.gpkg"))
    }),
  )

  it.instance("the directory an output is going into is made before the run, not after it", () =>
    Effect.gen(function* () {
      /* `ensureParents` is tested on its own in qgis-destination.test.ts, and
       * that test passes whether or not this tool ever calls it — the fifth
       * time in this codebase that a correct rule was computed on one side,
       * consumed on neither, and green on both.
       *
       * It has to happen BEFORE the spawn: QGIS given a path whose directory
       * does not exist fails with a driver message about the file, and upstream's
       * `write` settled the same question the same way (`writeWithDirs`) rather
       * than teaching every caller to make its own folder. */
      const instance = yield* InstanceState.context
      const deep = path.join(instance.directory, "results", "2026", "out.shp")
      writes = [deep]
      expect(fs.existsSync(path.dirname(deep))).toBe(false)

      yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: deep }),
      })

      expect(fs.existsSync(path.dirname(deep))).toBe(true)
    }),
  )

  it.instance("an output that landed where it was sent is not commented on", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "plain.shp")
      writes = [asked]

      const result = yield* succeed({
        algorithm: "native:writeout",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked }),
      })

      expect(result.metadata.destinations).toEqual([{ parameter: "OUTPUT", path: asked }])
      expect(result.output).not.toContain("chose the format")
    }),
  )

  it.instance("an algorithm that owns the question keeps its target, and the caller is told", () =>
    Effect.gen(function* () {
      /* The one case where "existing files are not overwritten" does not hold.
       *
       * `native:package` appends layers to a GeoPackage that has to be there
       * already. Numbering it would append to a new empty file and report
       * success, leaving the user's database untouched — and standing aside
       * silently would let the caller read protection into a run with none,
       * over data undo cannot bring back (§10.1 #6). */
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "atlas.gpkg")
      fs.writeFileSync(asked, "the user's database")
      writes = [asked]

      const result = yield* succeed({
        algorithm: "native:packager",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked, OVERWRITE: false }),
      })

      expect(sentParameters().OUTPUT).toBe(asked)
      expect(result.metadata.destinations).toEqual([{ parameter: "OUTPUT", path: asked }])
      // Named, not merely hinted at: the caller can act on the parameter and
      // cannot act on "something decided elsewhere".
      expect(result.output).toContain("OVERWRITE")
      expect(result.output).toContain(asked)
    }),
  )
})

describe("the string the user is asked to approve", () => {
  /* `describeCall` on its own, because the one thing it must never do cannot be
   * reached through the tool: abbreviating a PATH. The tool-level tests pass
   * ordinary paths, so a limit set too low would stay green there and only
   * surface in front of a user, on the one prompt they are meant to judge.
   */

  test("a path is never the thing that gets abbreviated", () => {
    // 250 characters — longer than any real path, still under the limit. The
    // limit is chosen against Windows' 260-character cap on purpose, so this
    // is the case that pins the two numbers together.
    const long = `/${"d".repeat(240)}/out.shp`
    expect(long.length).toBeGreaterThan(240)
    expect(describeCall("native:buffer", { OUTPUT: long })).toContain(long)
  })

  test("an inlined value is abbreviated, and says how much it dropped", () => {
    // What this is FOR: a pasted geometry can run to `PARAMETERS_LIMIT`
    // characters and tells the user nothing the parameter name did not. Cutting
    // it is fine; cutting it silently is not, because a prompt that hides half
    // its content reads as a complete one.
    const huge = "0".repeat(5_000)
    const shown = describeCall("native:buffer", { GEOMETRY: huge })
    expect(shown).not.toContain(huge)
    expect(shown).toContain("+4744 chars")
    expect(shown.length).toBeLessThan(400)
  })

  test("non-string values survive, because they are what makes a call dangerous", () => {
    // `gdal:rasterize_over` burns BURN into an existing raster. Rendering only
    // the paths would show a call that looks like every other one.
    const shown = describeCall("gdal:rasterize_over", { INPUT_RASTER: "/data/dem.tif", BURN: 99, ADD: false })
    expect(shown).toBe("gdal:rasterize_over(INPUT_RASTER=/data/dem.tif, BURN=99, ADD=false)")
  })
})
