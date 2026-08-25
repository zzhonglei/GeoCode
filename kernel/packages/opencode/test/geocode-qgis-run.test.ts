import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { Agent } from "../src/agent/agent"
import { GeoKernel, GeoQgis, GeoRuntime, GeoStatus } from "../src/geo"
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
import { statusHolding } from "./lib/geocode-status"

/* Tripwires for RunQgisAlgorithm (docs/TOOLS.md §3; GEOKERNEL §4.12, §11). Every return path is reachable with
 * no QGIS installed: the executor takes a `GeoRuntime.Interface`, so a scripted runtime and an open gate put any
 * ending under test. */

const ALGORITHM: QgisCatalog.Algorithm = {
  id: "native:buffer",
  name: "Buffer",
  group: "Vector geometry",
  description: "Computes a buffer.",
  helpText: "help",
  parameters: [
    { name: "INPUT", description: "in", type: "source", defaultValue: null, options: [], optional: false },
    // Non-optional and defaulted, the shape that turns a correct call into one alarm per parameter if pre-flight
    // files it under missing-required (executor.ts).
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

/* An algorithm that writes, which the buffer fixture above deliberately is not: its OUTPUT is non-optional,
 * defaults to `TEMPORARY_OUTPUT`, and carries one of the six types `destination.ts` re-points on (§4.12). */
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

/* The shape of `native:package` and `native:savefeatures`: a destination plus the algorithm's own parameter for a
 * file that is already there, which earns it no exemption from numbering (§4.12). */
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

/* No folder destination among them: this layer treats one like any other output, and the rule that spares it from
 * numbering is `qgis/destination.ts`'s, tested in geo/qgis-destination.test.ts. */
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
 * A runtime that leaves files behind, the way a real algorithm does. The mock above answers only what was sent,
 * and what is on disk is what tells a reserved path from the file QGIS named for itself.
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
 * A user who has already answered "always", standing in: `qgis` is `ask` for GeoAgent, so without this every test
 * below parks at an unanswered prompt. Appended last because `evaluate` takes the last matching rule, which is
 * where a real approval lands too (permission/index.ts).
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
 * Run the tool with every ask granted, recording what it asked for: the engine's verdict for a key is pinned in
 * geocode-geo-permissions.test.ts, and a grant nobody requests looks the same from there as one that works.
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

      // Running it is the only way to tell a grant that matched from one written under a key nothing asks with
      // (docs/KERNEL.md §4.1).
      const allowed = yield* execute({ algorithm: "native:buffer", parameters: "{}" })
      expect(Exit.isSuccess(allowed)).toBe(true)
    }),
  )

  it.instance(
    "a malformed tool call is blamed on the tool call, and never on QGIS",
    () =>
      Effect.gen(function* () {
        // A bare "Invalid parameters" reads as "QGIS rejected me" and sends the model hunting a bug in the data.
        for (const parameters of ["not json", "[1,2]", '"a string"', "null"]) {
          const result = yield* succeed({ algorithm: "native:buffer", parameters })
          expect(result.output).toContain("QGIS was NOT invoked")
          expect(result.output).toContain("on your end (the agent)")
          expect(result.metadata.param_error).toBe(true)
          // A synthetic 0ms would tell the agent the algorithm ran and finished instantly.
          expect(result.output).not.toContain("Elapsed:")
          expect(result.metadata.elapsed_ms).toBeUndefined()
        }
      }),
    // Four executions behind a full kernel build, which lands close enough to bun's five-second default to flake.
    { timeout: 20_000 },
  )

  it.instance("an over-long parameter string is refused where the cause is still known", () =>
    Effect.gen(function* () {
      // Past the OS command-line cap the spawn fails with nothing to attribute it to, and the limit is enforced
      // on every platform rather than the one that has the cap.
      const parameters = JSON.stringify({ INPUT: "x".repeat(PARAMETERS_LIMIT) })
      expect(parameters.length).toBeGreaterThan(PARAMETERS_LIMIT)
      const result = yield* succeed({ algorithm: "native:buffer", parameters })
      expect(result.metadata.error_code).toBe("ParametersTooLong")
      expect(result.output).toContain("QGIS was NOT invoked")
      expect(result.output).not.toContain("Elapsed:")

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
      // Filed as `crash` this would read out as a native library segfaulting below the Python level, with an
      // elapsed footer for a process that never existed.
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
        // Every parameter supplied, so pre-flight has nothing to say.
        const result = yield* succeed({
          algorithm: "native:buffer",
          parameters: '{"INPUT":"/a.shp","SEGMENTS":5,"DISSOLVE":false,"DISTANCE":1}',
        })
        expect(result.title).toBe("Buffer")
        expect(result.metadata.display_name).toBe("Buffer")
        expect(result.metadata.exit_code).toBe(0)
        expect(result.output).toContain("Progress: 50%")
        expect(result.output).toContain("Elapsed:")
        expect(result.output).not.toContain("---")
        expect(result.metadata.failed).toBeUndefined()
        // Empty rather than absent: an absent `precheck` is how the tool says it never got that far.
        expect(result.metadata.precheck).toEqual([])
      }),
  )

  ending({ code: null, reason: "abort" }, ["Progress: 20%\n"]).instance(
    "a cancelled run keeps what it produced and says it was cancelled",
    () =>
      Effect.gen(function* () {
        // Upstream completes a cancelled call with whatever the tool returned (session/tools.ts), so silence here
        // files the user's own Esc under "it failed".
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
      // The fix for this ending is a number, so a banner that omits it leaves the caller nothing to raise.
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
      // The runner script names no tools itself (§11), so the pointer to the schema comes from this layer.
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"NOPE":1}' })
      expect(result.output).toContain("is not defined for")
      expect(result.output).toContain('QgisDoc with action="read", algorithm="native:buffer"')

      // And nothing wrong gets no pointer: a line that fires on every run is what makes pre-flight ignorable.
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
        // The live push keeps the tail, where a running algorithm says anything new, and marks the drop so a
        // watcher cannot read a partial log as the whole one.
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
        // The final result is a different payload and answers for its own size.
        expect(result.metadata.truncated).toBe(false)
      }),
  )

  ending({ code: null, reason: "crash", stderr: "Fatal Python error: Segmentation fault" }).instance(
    "a crash carries the native trace and explains the OS dialog",
    () =>
      Effect.gen(function* () {
        // The macOS crash reporter puts a dialog in front of the user after the tool has already returned, and
        // this sentence is how the agent can tell them to dismiss it.
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.output).toContain("Segmentation fault")
        expect(result.output).toContain("safe to dismiss")
        // The renderer is shared with GEE, which runs its own Python, so naming one capability would have the
        // other's crashes blame software the user never invoked.
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
      // Pre-flight advises and never vetoes: the exported metadata cannot express every constraint, so blocking
      // on its gaps would turn them into "the user cannot run this" (§4.12).
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
      // Supplying exactly the parameters that have no default is a correct call, and one alarm per defaulted
      // parameter is what teaches a reader to skip the channel that guards the user's disk.
      const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
      const kinds = (result.metadata.precheck as { kind: string }[]).map((hint) => hint.kind)
      expect(kinds).toEqual(["defaults-applied"])
      expect(result.output).not.toContain("is missing")

      // One line, carrying the values the run will use — which are the ones a caller may want to override.
      const lines = result.output.split("\n").filter((line) => line.startsWith("Pre-flight:"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("SEGMENTS=5")
      expect(lines[0]).toContain("DISSOLVE=False")
    }),
  )

  ending({ code: 0, reason: "exit" }).instance("QGIS is handed the canonical id, not the caller's spelling", () =>
    Effect.gen(function* () {
      // Lookup tolerates display names and short forms (§4.11) where QGIS resolves full ids only, so the raw key
      // would clear pre-flight and then fail inside the interpreter with nothing to explain it.
      const result = yield* succeed({ algorithm: "Buffer", parameters: '{"INPUT":"/a.shp"}' })
      expect(spawned.args).toContain("native:buffer")
      expect(spawned.args).not.toContain("Buffer")
      expect(result.metadata.resolved_algorithm).toBe("native:buffer")
      expect(result.metadata.algorithm).toBe("Buffer")
    }),
  )

  ending({ code: 0, reason: "exit" }, ["Progress: 10%\n", "Results: {'OUTPUT': '/out.gpkg'}\n"]).instance(
    "the tool always answers for its own size, so nothing upstream cuts the tail",
    () =>
      Effect.gen(function* () {
        // Setting `truncated` at all is what stops tool.ts running its generic truncation, which keeps the head
        // and drops the tail — where the ending, the error and the elapsed footer live.
        const result = yield* succeed({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' })
        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.truncated).toBeDefined()
        expect(result.output).toContain("Results:")
        expect(result.output).toContain("Elapsed:")
      }),
  )
})

describe("RunQgisAlgorithm, shapes", () => {
  test("every ending has a banner, and only success has none", () => {
    // A shared or missing opening is one ending arriving as another.
    const reasons = ["abort", "idle", "timeout", "crash", "output-limit"] as const
    const banners = reasons.map((reason) => GeoTool.terminationBanner(reason, "detail"))
    expect(new Set(banners).size).toBe(reasons.length)
    for (const banner of banners) expect(banner.startsWith("---")).toBe(true)

    expect(GeoTool.terminationBanner("abort")).toContain("User cancelled")
    expect(GeoTool.terminationBanner("exit", "boom")).toContain("boom")
    expect(GeoTool.terminationBanner("exit")).toBe("")
  })

  test("the elapsed footer uses the kernel's one duration format", () => {
    expect(GeoTool.elapsedFooter(500)).toBe("Elapsed: 500ms")
    expect(GeoTool.elapsedFooter(1_500)).toBe("Elapsed: 1.5s")
    expect(GeoTool.elapsedFooter(90_000)).toBe("Elapsed: 1m30s")
  })

  test("the QGIS group speaks with one voice about its environment", () => {
    // Three descriptions, one gate behind them: edit one and the agent's behaviour starts depending on which
    // tool it happened to call first.
    const shared =
      "This tool needs the user's QGIS environment. When that environment is not ready, the output says exactly what is missing and who can fix it — relay that to the user instead of retrying."
    for (const description of [READ_DESCRIPTION, DOC_DESCRIPTION, RUN_DESCRIPTION]) {
      expect(description).toContain(shared)
    }

    // A run in the wrong coordinate system succeeds and writes a wrong answer, so losing these lines costs
    // nothing visible.
    expect(RUN_DESCRIPTION).toContain("a 500m buffer becomes 500 degrees")
    expect(RUN_DESCRIPTION).toContain("MUST use QgisDoc")
    expect(RUN_DESCRIPTION).toContain("GeoJSON output MUST be in WGS-84")

    // An agent that does not know the tool may answer with another path chains its next step onto the name it
    // asked for, and reads a file that was never written.
    expect(RUN_DESCRIPTION).toContain('"out.shp" becomes "out (1).shp"')
    expect(RUN_DESCRIPTION).toContain("Use that path for the next step")

    /* The limits of that promise, asserted as consequences rather than wording so the text can keep improving
     * (docs/TOOLS.md §8): an unconditional "never overwritten" overstates a guarantee that yields to a folder
     * destination, and the two parameters stay named so a model reaching for `OVERWRITE` to add a layer to an
     * existing GeoPackage reads here that it gets a new file instead. */
    expect(RUN_DESCRIPTION).not.toContain("never overwritten")
    expect(RUN_DESCRIPTION).not.toMatch(/in the algorithm's hands|left to honour/i)
    expect(RUN_DESCRIPTION).toContain("OVERWRITE")
    expect(RUN_DESCRIPTION).toContain("ACTION_ON_EXISTING_FILE")
    expect(RUN_DESCRIPTION).toMatch(/directory destination is written into as it stands/i)
    // The way out, without which the warning is a dead end.
    expect(RUN_DESCRIPTION).toMatch(/move or remove it/i)
    // And the mistake that lands a caller in the renaming case to begin with.
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
        // A shut gate is one event, and a caller made to learn three field sets ends up handling whichever tool
        // it met first.
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
          // The shared trio; a tool may add its own subject on top, but recognising the event may not depend on
          // which one produced it.
          expect(answer.metadata.error).toBe(true)
          expect(answer.metadata.geoStatus).toBe("unconfigured")
          expect(answer.metadata.truncated).toBe(false)
          // The guidance is the kernel's, so all three say the same thing about the same state.
          expect(answer.output).toContain("machine.json")
          // No synonym for `error`: a second flag meaning the same thing is how the three drift apart.
          expect("env_error" in answer.metadata).toBe(false)
        }
      }),
    { timeout: 20_000 },
  )

  test("a shut gate on a READY environment still names its cause", () => {
    // The gate wants ready and processing and a built catalog (§4.9), so the bare status name would put
    // `error: true` next to `geoStatus: "ready"` and leave the cause readable only in the prose.
    expect(GeoTool.gateStatus({ status: "unconfigured" })).toBe("unconfigured")
    expect(GeoTool.gateStatus({ status: "ready", processing: true, catalog: "ready" } as never)).toBe("ready")
    const refused = [
      { status: "ready", processing: false, catalog: "skipped" },
      { status: "ready", processing: true, catalog: "building" },
      { status: "ready", processing: true, catalog: "failed" },
    ] as const
    const labels = refused.map((status) => GeoTool.gateStatus(status as never))
    for (const label of labels) expect(label).not.toBe("ready")
    // Three refusals, three labels: one shared label moves the ambiguity rather than removing it.
    expect(new Set(labels).size).toBe(refused.length)
  })
})

describe("RunQgisAlgorithm, where the output lands", () => {
  /* `qgis/destination.ts` owns the rule and is tested on its own; what is asserted here is the wiring, since a
   * correct rule that is computed and then not passed on protects nothing. */
  const it = harness(runtimeEnding({}))

  /** `runScript` puts the parameters last (executor.ts); read from the end, since the wrapper's shape is its own. */
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

      // Reporting the new path while spawning with the old one reads correctly in the output and destroys the
      // file anyway.
      const expected = path.join(instance.directory, "out (1).shp")
      expect(sentParameters().OUTPUT).toBe(expected)
      expect(sentParameters().OUTPUT).not.toBe(asked)
      // The run went through, so this is not a refusal being passed off as protection.
      expect(result.metadata.error_code).toBeUndefined()
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
      // A frontend offering "open the result" reads this channel and never the prose (§9.1).
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "scene (1).tif") },
      ])
    }),
  )

  it.instance("an untaken output is passed through and never mentioned", () =>
    Effect.gen(function* () {
      // A note that fires on every run is what gets the channel skipped on the run that matters.
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
      // Renaming an input sends the algorithm to read a file that is not there — a correct call broken by the
      // thing meant to protect it — so re-pointing is fenced on the catalog calling the parameter a destination.
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
      /* No second `external_directory` ask for a target outside the working directory, the way `read`, `write`
       * and `bash` each raise one (docs/TOOLS.md §4.3). Both placements in one test on purpose: split apart, a
       * change that re-introduced the second ask for outside targets alone leaves the inside case green. */
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
      /* With no second boundary ask, this string is all the user gets to judge, and each assertion below is one
       * way to hollow it out: the algorithm alone says nothing about what it writes to, a worktree-relative path
       * hides that the target is outside the workspace, and dropping non-path values hides the `DISTANCE=100`
       * this one turns on. */
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "geocode-outside-"))
      try {
        const target = path.join(outside, "out.shp")
        const asked = yield* asksOf({
          algorithm: "native:writeout",
          parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: target, DISTANCE: 100 }),
        })
        const pattern = asked[0]!.patterns![0]!
        expect(pattern).toContain("native:writeout")
        // Absolute and verbatim: `toContain` on the full path fails for any relative form.
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
      // Without catalog metadata a destination cannot be told from any other string, and guessing would re-point
      // a parameter that was never an output; the call still runs (§4.12).
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
      // The re-point happens before the spawn, so the sentence is available either way; printing it for a
      // failure sends the caller looking for a file that was never created.
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
      // Still in the structured channel, where `failed` sits beside it to say the file is not there.
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "out (1).shp") },
      ])
    }),
  )
})

describe("RunQgisAlgorithm, the path the caller is sent to", () => {
  /* The cases where the reserved path is not the answer. Both are computed in `qgis/destination.ts` and tested
   * there, and both need a runtime that writes, since the question is what is on disk when the run is over. */
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

      // What was sent is untouched, since predicting the format is QGIS's business and not this tool's.
      expect(sentParameters().OUTPUT).toBe(asked)
      // What is reported is what exists: the caller is told to use this path next, and `/…/result` is not there.
      expect(result.metadata.destinations).toEqual([
        { parameter: "OUTPUT", path: path.join(instance.directory, "result.gpkg") },
      ])
      expect(result.output).toContain(path.join(instance.directory, "result.gpkg"))
    }),
  )

  it.instance("the directory an output is going into is made before the run, not after it", () =>
    Effect.gen(function* () {
      /* qgis-destination.test.ts passes whether or not this tool ever calls `ensureParents`, and it has to happen
       * before the spawn: QGIS handed a path whose directory does not exist fails with a driver message about
       * the file. */
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

  it.instance("an algorithm that claims to own the question is numbered anyway", () =>
    Effect.gen(function* () {
      // An `OVERWRITE` parameter earns no exemption (geo/qgis/destination.ts), and what is pinned here is that
      // the numbered path reaches QGIS and the report rather than only being computed.
      const instance = yield* InstanceState.context
      const asked = path.join(instance.directory, "atlas.gpkg")
      const numbered = path.join(instance.directory, "atlas (1).gpkg")
      fs.writeFileSync(asked, "the user's database")
      writes = [numbered]

      const result = yield* succeed({
        algorithm: "native:packager",
        parameters: JSON.stringify({ INPUT: "/data/in.shp", OUTPUT: asked, OVERWRITE: false }),
      })

      expect(sentParameters().OUTPUT).toBe(numbered)
      expect(result.metadata.destinations).toEqual([{ parameter: "OUTPUT", path: numbered }])
      expect(fs.readFileSync(asked, "utf8")).toBe("the user's database")
      // And a call that meant to append is told this file is not that.
      expect(result.output).toContain("not an addition")
    }),
  )
})

describe("the environment comes before the prompt", () => {
  /* Every install passes through "not configured yet", and reaching it through a permission dialog spends the
   * one approval this tool relies on — `always` would record it — on a call that was never going to run. Pinned
   * across the settled failure states, and the other way for the in-flight ones. */
  const STOPPED: GeoEvent.QgisStatus[] = [
    { status: "unconfigured" },
    { status: "config-error", file: "/x/machine.json", message: "bad" },
    { status: "path-missing" },
    { status: "not-qgis" },
  ]

  const askedUnder = (qgis?: GeoEvent.QgisStatus) =>
    testEffect(
      LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [GeoQgis.node, openGate],
        [QgisCatalog.node, stubCatalog],
        [GeoRuntime.node, runtimeEnding({})],
        [GeoStatus.node, statusHolding(qgis ? { qgis } : {})],
      ]),
    )

  const record = Effect.fnUntraced(function* () {
    const registry = yield* ToolRegistry.Service
    const tool = (yield* registry.all()).find((item) => item.id === "RunQgisAlgorithm")!
    const asked: string[] = []
    const result = yield* tool
      .execute({ algorithm: "native:buffer", parameters: '{"INPUT":"/a.shp"}' }, {
        sessionID: SessionID.make("ses_env"),
        messageID: MessageID.make("msg_env"),
        agent: "GeoAgent",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req: any) => Effect.sync(() => void asked.push(req.permission)),
      } as any)
      .pipe(Effect.timeout(10_000), Effect.exit)
    return { asked, result }
  })

  for (const qgis of STOPPED) {
    askedUnder(qgis).instance(`"${qgis.status}" is answered without a prompt`, () =>
      Effect.gen(function* () {
        const { asked, result } = yield* record()
        expect(asked).toEqual([])
        expect(Exit.isSuccess(result)).toBe(true)
        if (!Exit.isSuccess(result)) throw new Error("refused")
        // Guidance rather than an empty refusal: this answer is how the user learns what to configure.
        expect(result.value.output.length).toBeGreaterThan(20)
        expect(result.value.metadata.error).toBe(true)
      }),
    )
  }

  askedUnder({ status: "probing" }).instance("a probe in flight is not a dead end", () =>
    Effect.gen(function* () {
      // `settledQgisGate` waits this out, so refusing here would turn a cold start into a failure.
      const { asked } = yield* record()
      expect(asked).toContain("qgis")
    }),
  )

  askedUnder(undefined).instance("an unknown status is not a dead end either", () =>
    Effect.gen(function* () {
      const { asked } = yield* record()
      expect(asked).toContain("qgis")
    }),
  )
})

describe("the string the user is asked to approve", () => {
  /* `describeCall` on its own, because the tool-level tests pass ordinary paths: a value limit set too low stays
   * green there and surfaces only in front of a user, on the one prompt they are meant to judge. */

  test("a path is never the thing that gets abbreviated", () => {
    // 249 characters, under a value limit that is sized against Windows' 260-character path cap.
    const long = `/${"d".repeat(240)}/out.shp`
    expect(long.length).toBeGreaterThan(240)
    expect(describeCall("native:buffer", { OUTPUT: long })).toContain(long)
  })

  test("an inlined value is abbreviated, and says how much it dropped", () => {
    // A pasted geometry runs to thousands of characters and tells the user nothing the parameter name did not;
    // cutting it silently would leave a prompt that hides half its content reading as a complete one.
    const huge = "0".repeat(5_000)
    const shown = describeCall("native:buffer", { GEOMETRY: huge })
    expect(shown).not.toContain(huge)
    expect(shown).toContain("+4744 chars")
    expect(shown.length).toBeLessThan(400)
  })

  test("non-string values survive, because they are what makes a call dangerous", () => {
    // `gdal:rasterize_over_fixed_value` burns BURN into an existing raster, and rendering only the paths would
    // show a call that looks like every other one.
    const shown = describeCall("gdal:rasterize_over_fixed_value", { INPUT_RASTER: "/data/dem.tif", BURN: 99, ADD: false })
    expect(shown).toBe("gdal:rasterize_over_fixed_value(INPUT_RASTER=/data/dem.tif, BURN=99, ADD=false)")
  })
})
