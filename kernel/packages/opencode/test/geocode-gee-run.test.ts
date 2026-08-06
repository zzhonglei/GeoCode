import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { Agent } from "../src/agent/agent"
import { GeeService, GeoKernel, GeoRuntime, GeoStatus } from "../src/geo"
import { InstanceState } from "../src/effect/instance-state"
import { Permission } from "../src/permission"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { ToolRegistry } from "../src/tool/registry"
import { GeoTool } from "../src/tool/geo-tool"
import RUN_DESCRIPTION from "../src/tool/geo-gee-run.txt"
import { MessageID, SessionID } from "../src/session/schema"
import { disposeAllInstances } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

/* Tripwires for RunGeeScript (docs/TOOLS.md §3; GEOKERNEL §5.9, §5.5, §11.2).
 *
 * Every return path is reachable without credentials, a project, or a network:
 * the executor is a free function over GeoRuntime.Interface, and the gate is a
 * service that can be handed over open or shut. What that buys is the one
 * thing this tool cannot be trusted on otherwise — the authorization loop,
 * whose whole point is that it fires on a REAL refusal, which no machine with
 * a healthy setup would ever produce on demand.
 */

const ENVIRONMENT: GeeService.Environment = {
  python: "/fake/envs/geo/bin/python3",
  project: "ee-demo",
  version: "1.7.24",
  route: "direct",
  env: { HTTPS_PROXY: "" },
}

const READY: GeoEvent.GeeStatus = {
  facing: "runtime",
  setup: { status: "ready", python: ENVIRONMENT.python, project: "ee-demo", version: "1.7.24" },
  network: { status: "reachable", route: "direct" },
  runtime: { status: "valid", route: "direct" },
}

const SHUT: GeoEvent.GeeStatus = {
  facing: "setup",
  setup: { status: "credentials-missing", python: ENVIRONMENT.python },
  network: { status: "idle" },
  runtime: { status: "unknown" },
}

/** What the gate was asked, and what a run reported back to it. */
const seen: { rejected: string[]; rechecks: number } = { rejected: [], rechecks: 0 }

/**
 * A GEE service under the test's control.
 *
 * `reject` answers the way the real one does — only an authorization refusal
 * counts — because the tool's behaviour differs on that answer and a stub that
 * always said yes would hide the difference.
 */
function geeService(gate: GeeService.Gate, options: { recheck?: boolean } = {}) {
  return Layer.succeed(
    GeeService.Service,
    GeeService.Service.of({
      gate: () => Effect.succeed(gate),
      recheck: () =>
        Effect.sync(() => {
          seen.rechecks += 1
          return options.recheck ?? false
        }),
      validate: () => Effect.succeed({ status: "unknown" }),
      reject: (message: string) =>
        Effect.sync(() => {
          seen.rejected.push(message)
          return /permission|not been used|credential/i.test(message)
        }),
    }),
  )
}

/** A runtime whose single run() reports whatever ending the test asks for. */
function runtimeEnding(result: Partial<GeoRuntime.Result>, chunks: readonly string[] = []) {
  return Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.gen(function* () {
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

const harness = (runtime: Layer.Layer<GeoRuntime.Service>, gee: Layer.Layer<GeeService.Service>) =>
  testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [GeeService.node, gee],
      [GeoRuntime.node, runtime],
    ]),
  )

const execute = Effect.fnUntraced(function* (params: Record<string, unknown>, agentName = "GeoAgent") {
  const registry = yield* ToolRegistry.Service
  const permission = yield* Permission.Service
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  const tool = (yield* registry.all()).find((item) => item.id === "RunGeeScript")
  expect(tool).toBeDefined()
  return yield* tool!
    .execute(params, {
      sessionID: SessionID.make("ses_gee_test"),
      messageID: MessageID.make("msg_gee_test"),
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) =>
        permission
          .ask({ ...req, sessionID: SessionID.make("ses_gee_test"), ruleset: agent!.permission })
          .pipe(Effect.orDie),
    })
    .pipe(Effect.timeout(10_000), Effect.exit)
})

const succeed = Effect.fnUntraced(function* (params: Record<string, unknown>) {
  const result = yield* execute(params)
  expect(Exit.isSuccess(result)).toBe(true)
  if (!Exit.isSuccess(result)) throw new Error("refused")
  return result.value
})

const open = geeService({ ok: true, environment: ENVIRONMENT })

afterEach(async () => {
  seen.rejected = []
  seen.rechecks = 0
  await disposeAllInstances()
})

describe("RunGeeScript, registration and the boundary", () => {
  const it = harness(runtimeEnding({}), open)

  it.instance("is in the registry, and the wildcard actually covers its key", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("RunGeeScript")

      // GeoAgent carries `geo_gee_*`; this tool asks under `geo_gee_run`. Only
      // a behavioural check tells "the wildcard covers it" from "it silently
      // misses", and a miss falls through to the global `geo_*: deny`
      // (docs/TOOLS.md §4.1, §4.2).
      const allowed = yield* execute({ script: "print(1)" })
      expect(Exit.isSuccess(allowed)).toBe(true)

      const denied = yield* execute({ script: "print(1)" }, "plan")
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("rule which prevents")
    }),
  )
})

describe("RunGeeScript, pre-spawn refusals", () => {
  const it = harness(runtimeEnding({}), open)

  it.instance("a malformed call is blamed on the call, and never on Earth Engine", () =>
    Effect.gen(function* () {
      // The old build's lesson, carried over from the QGIS runner: a bare
      // "Invalid parameters" reads as "GEE rejected me" and sends the model
      // hunting for a bug that is not there.
      const neither = yield* succeed({})
      expect(neither.output).toContain("Python was NOT invoked")
      expect(neither.output).toContain("on your end (the agent)")
      expect(neither.metadata.param_error).toBe(true)

      const both = yield* succeed({ script: "print(1)", script_path: "/tmp/x.py" })
      expect(both.output).toContain("exactly one is expected")
      expect(both.output).toContain("Python was NOT invoked")

      // Two different mistakes, two different diagnoses.
      expect(neither.output).not.toBe(both.output)
    }),
  )

  it.instance("a missing script file says so before anything spawns", () =>
    Effect.gen(function* () {
      const target = path.join(os.tmpdir(), "geocode-absent-script.py")
      fs.rmSync(target, { force: true })
      const result = yield* succeed({ script_path: target })
      expect(result.output).toContain(target)
      expect(result.metadata.error_code).toBe("ScriptNotFound")
    }),
  )

  it.instance("no refusal claims a duration for a run that never happened", () =>
    Effect.gen(function* () {
      // A synthetic footer here would tell the Agent the script ran and
      // finished instantly, which is worse than saying nothing (§11.2).
      for (const params of [{}, { script: "x", script_path: "/tmp/y.py" }, { script_path: "/nope/z.py" }]) {
        const result = yield* succeed(params)
        expect(result.output).not.toContain("Elapsed:")
        expect(result.metadata.elapsed_ms).toBeUndefined()
      }
    }),
  )
})

describe("RunGeeScript, a shut gate", () => {
  const it = harness(runtimeEnding({}), geeService({ ok: false, status: SHUT }))

  it.instance("a refusal carries the kernel's guidance, not a sentence of its own", () =>
    Effect.gen(function* () {
      // The whole GEE group speaks with one voice, authored in the kernel
      // (§8.6). A tool writing its own environment copy is how two callers
      // start telling a user different things about one problem.
      const result = yield* succeed({ script: "print(1)" })
      expect(result.output).toContain("Step 3 of 4")
      expect(result.output).toContain("earthengine")
      expect(result.metadata.error).toBe(true)
      // Both halves: which layer, AND its own state. "setup" alone covers both
      // "no interpreter configured" and "not signed in", and a surface that
      // cannot tell those apart has the same button for both.
      expect(result.metadata.geoStatus).toBe("setup:credentials-missing")
      expect(result.output).not.toContain("Elapsed:")
    }),
  )
})

describe("RunGeeScript, the endings", () => {
  const ending = (result: Partial<GeoRuntime.Result>, chunks?: readonly string[]) =>
    harness(runtimeEnding(result, chunks), open)

  ending({ reason: "idle", code: null }, ["working\n"]).instance(
    "an idle stop names the contract the script did not keep",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "print('working')" })
        // The fix for this ending is not a bigger timeout — this tool has no
        // timeout parameter — it is heartbeat(). Saying "no output for too
        // long" without naming it leaves the Agent reaching for a knob that
        // does not exist (§5.9 心跳契约).
        expect(result.output).toContain("heartbeat()")
        expect(result.output).toContain(`${GeeService.GeeExecutor.IDLE_FLOOR_SECONDS}s`)
        expect(result.metadata.error_code).toBe("IdleTimeout")
        expect(result.metadata.timed_out).toBe(true)
        // Whatever it managed to print survives.
        expect(result.output).toContain("working")
        expect(result.output).toContain("Elapsed:")
      }),
  )

  ending({ reason: "abort", code: null }, ["partial\n"]).instance("a cancelled run says the user cancelled it", () =>
    Effect.gen(function* () {
      // Upstream does not interrupt a tool on cancellation — it takes what
      // the tool returns and completes the call with it. Silence here files
      // the user's own cancellation under "it failed".
      const result = yield* succeed({ script: "print('partial')" })
      expect(result.output).toContain("User cancelled execution")
      expect(result.output).toContain("partial")
      expect(result.metadata.aborted).toBe(true)
    }),
  )

  ending({ reason: "crash", code: null, stderr: "SIGSEGV" }).instance(
    "a native crash is explained without blaming a capability",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "import ee" })
        expect(result.output).toContain("SIGSEGV")
        expect(result.output).toContain("segfault inside a native library")
        // The banner is shared with the QGIS runner, so it must not name one
        // capability's interpreter — GEE runs its own Python.
        expect(result.output).not.toContain("QGIS")
        expect(result.metadata.error_code).toBe("Crashed")
      }),
  )

  ending({ reason: "exit", code: 1, stderr: "Traceback...\nValueError: bad band" }, ["step 1\n"]).instance(
    "a script that failed shows what Python said",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "raise ValueError()" })
        expect(result.output).toContain("ValueError: bad band")
        expect(result.output).toContain("step 1")
        expect(result.metadata.exit_code).toBe(1)
        expect(result.metadata.failed).toBe(true)
      }),
  )

  harness(
    Layer.mock(GeoRuntime.Service)({
      run: () => Effect.fail(new Error("spawn /gone/bin/python3 ENOENT")),
      killAllSync: () => {},
    }),
    open,
  ).instance(
    "a launch that never happened is not reported as a crash",
    () =>
      Effect.gen(function* () {
        // Filing this as `crash` told the agent a native library segfaulted below
        // the Python level and could not be caught — for an interpreter that was
        // simply not there. Both real causes are fixable configuration.
        const result = yield* succeed({ script: "print(1)" })
        expect(result.output).toContain("never ran")
        expect(result.output).toContain("ENOENT")
        expect(result.output).toContain("gee.python")
        expect(result.output).not.toContain("segfault")
        expect(result.output).not.toContain("unexpectedly quit")
        // Nothing ran, so nothing took any time. A footer here would say the
        // script ran and finished instantly.
        expect(result.output).not.toContain("Elapsed:")
        expect(result.metadata.elapsed_ms).toBeUndefined()
        expect(result.metadata.error_code).toBe("LaunchFailed")
        // The same flag the shut gate sets, because it is the same kind of
        // fact: the environment is in the way, not the script. One spelling.
        expect(result.metadata.error).toBe(true)
        expect(result.metadata.env_error).toBeUndefined()
        // And it is not filed under the endings that mean "it ran and stopped".
        expect(result.metadata.partial).toBeUndefined()
        expect(result.metadata.failed).toBeUndefined()
      }),
    { timeout: 20_000 },
  )

  ending({}, ["ndvi mean: 0.42\n"]).instance("a run that succeeded returns its output and its duration", () =>
    Effect.gen(function* () {
      const result = yield* succeed({ script: "print('ndvi mean: 0.42')" })
      expect(result.output).toContain("ndvi mean: 0.42")
      expect(result.output).toContain("Elapsed:")
      expect(result.metadata.exit_code).toBe(0)
      expect(result.metadata.failed).toBeUndefined()
      expect(result.metadata.error_code).toBeUndefined()
    }),
  )
})

describe("RunGeeScript, the authorization loop", () => {
  harness(
    runtimeEnding({
      reason: "exit",
      code: 1,
      stderr: "ee.ee_exception.EEException: Permission denied on project ee-demo",
    }),
    open,
  ).instance("a refusal from the remote updates the stored conclusion", () =>
    Effect.gen(function* () {
      const result = yield* succeed({ script: "init_gee()" })
      // §5.5's other half. The stored conclusion can sit on "valid"
      // indefinitely — credentials get revoked without the route changing —
      // and the only affordable check is the user's own call.
      expect(seen.rejected).toHaveLength(1)
      expect(seen.rejected[0]).toContain("Permission denied")
      expect(result.metadata.auth_rejected).toBe(true)
    }),
  )

  harness(runtimeEnding({ reason: "exit", code: 1, stderr: "ZeroDivisionError: division by zero" }), open).instance(
    "a script that failed on its own logic does not touch the authorization",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "1/0" })
        // The message still goes to the kernel — it owns the judgement of what
        // counts — but nothing about a division by zero says the credentials
        // stopped working, and marking it would invalidate a perfectly good
        // authorization on every buggy script.
        expect(seen.rejected).toHaveLength(1)
        expect(result.metadata.auth_rejected).toBeUndefined()
        expect(result.output).not.toContain("Step 1 of 4")
      }),
  )

  harness(runtimeEnding({ stderr: "some warning on stderr" }), open).instance(
    "a successful run reports nothing back",
    () =>
      Effect.gen(function* () {
        yield* succeed({ script: "print(1)" })
        expect(seen.rejected).toHaveLength(0)
      }),
  )

  harness(
    runtimeEnding({ reason: "abort", code: null, stderr: "checking permission for asset ee-demo/x" }),
    open,
  ).instance("a killed run is not evidence about authorization", () =>
    Effect.gen(function* () {
      // A cancelled process leaves whatever it had printed in stderr, and that
      // text was never the remote's answer to anything. Reading it as one would
      // revoke a working authorization on the strength of a log line that
      // happened to mention permissions — and the user would then be walked
      // through signing in again to fix a problem they created by pressing Esc.
      const result = yield* succeed({ script: "print('long job')" })
      expect(seen.rejected).toHaveLength(0)
      expect(result.metadata.auth_rejected).toBeUndefined()
      expect(result.metadata.aborted).toBe(true)
    }),
  )
})

describe("RunGeeScript, output that does not fit", () => {
  // The one geographic tool where this is real: an algorithm's output is a
  // property of the algorithm, but this one is whatever a script the Agent
  // WROTE decides to print.
  const flood = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")

  harness(runtimeEnding({}, [flood, "\nFINAL ANSWER: 0.42\n"]), open).instance(
    "a flood keeps the tail and says it was cut",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "print(lots)" })
        expect(result.metadata.truncated).toBe(true)
        // The TAIL survives — where a script says its result and where the
        // banner and footer are appended. Upstream's own truncation keeps the
        // head, which is why declaring `truncated` matters here.
        expect(result.output).toContain("FINAL ANSWER: 0.42")
        expect(result.output).toContain("Elapsed:")
        expect(result.output).toContain("earlier output trimmed")
        expect(result.output).not.toContain("line 0 ")

        // Declaring `truncated` skips upstream's truncation, and that is also
        // what would have saved the full text. Trimming without doing this
        // means the cut part is gone for good (docs/TOOLS.md §5.2).
        const saved = result.metadata.outputPath as string
        expect(saved).toBeTruthy()
        expect(result.output).toContain(saved)
        const complete = fs.readFileSync(saved, "utf8")
        expect(complete).toContain("line 0 ")
        expect(complete).toContain("FINAL ANSWER: 0.42")
      }),
  )

  harness(runtimeEnding({}, ["short and sweet\n"]), open).instance("an ordinary run leaves nothing behind", () =>
    Effect.gen(function* () {
      const result = yield* succeed({ script: "print('short and sweet')" })
      expect(result.metadata.truncated).toBe(false)
      expect(result.metadata.outputPath).toBeUndefined()
    }),
  )
})

/* The pieces below are free functions, tested directly — the behaviour they
 * carry is invisible from the tool's return value. */

const statusReading = (value: GeoEvent.GeeStatus | undefined): GeoStatus.Interface =>
  ({
    register: () => Effect.die("unused"),
    current: () => Effect.succeed(value),
    snapshot: () => Effect.die("unused"),
    watch: () => Stream.empty,
  }) as unknown as GeoStatus.Interface

describe("the GEE environment header", () => {
  test("a usable Earth Engine is described; anything else stays silent", async () => {
    const ready = await Effect.runPromise(GeoTool.geeHeader(statusReading(READY)))
    expect(ready).toContain("ee-demo")
    expect(ready).toContain(ENVIRONMENT.python)
    expect(ready).toContain("1.7.24")

    // Every not-ready shape renders nothing, because the guidance for those
    // states already prints the interpreter, the project and the reason — a
    // header above it would be the duplication the old build's first tier
    // existed to avoid.
    for (const status of [
      SHUT,
      { ...READY, facing: "network", network: { status: "unreachable" } } as GeoEvent.GeeStatus,
      {
        ...READY,
        runtime: { status: "failed", reason: "project-invalid", message: "no" },
      } as GeoEvent.GeeStatus,
      undefined,
    ]) {
      expect(await Effect.runPromise(GeoTool.geeHeader(statusReading(status)))).toBeUndefined()
    }
  })
})

describe("the gate's wait", () => {
  const service = (gates: GeoEvent.GeeStatus[], recheck: boolean): GeeService.Interface => {
    let index = 0
    return {
      gate: () =>
        Effect.sync(() => {
          const status = gates[Math.min(index++, gates.length - 1)]!
          return status === READY
            ? ({ ok: true, environment: ENVIRONMENT } as GeeService.Gate)
            : ({ ok: false, status } as GeeService.Gate)
        }),
      recheck: () =>
        Effect.sync(() => {
          seen.rechecks += 1
          return recheck
        }),
      validate: () => Effect.succeed({ status: "unknown" }),
      reject: () => Effect.succeed(false),
    }
  }

  test("a retry asks the kernel to look again (§5.8)", async () => {
    // Three of the states a user lands in are fixed OUTSIDE machine.json — they
    // install a package, they run the authentication command — and neither
    // action touches the file the watcher watches. Without this, someone who
    // has just done exactly what they were told is told the same thing again.
    seen.rechecks = 0
    const gate = await Effect.runPromise(GeoTool.settledGeeGate(service([SHUT], false)))
    expect(seen.rechecks).toBe(1)
    expect(gate.ok).toBe(false)
  })

  test("a probe in flight is waited out rather than reported as an answer", async () => {
    const probing: GeoEvent.GeeStatus = {
      facing: "setup",
      setup: { status: "checking" },
      network: { status: "idle" },
      runtime: { status: "unknown" },
    }
    seen.rechecks = 0
    // Checking, checking, then ready: a cold start, which without the wait
    // turns every first call into "Earth Engine is not ready".
    const gate = await Effect.runPromise(GeoTool.settledGeeGate(service([probing, probing, READY], false)))
    expect(gate.ok).toBe(true)
  })

  test("a settled refusal is returned at once, not waited on", async () => {
    seen.rechecks = 0
    const started = Date.now()
    const gate = await Effect.runPromise(GeoTool.settledGeeGate(service([SHUT, SHUT, SHUT], false)))
    expect(gate.ok).toBe(false)
    // credentials-missing is an answer. Polling it to the deadline would hang
    // the tool for a minute to learn what it already knew.
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("the description and the code agree", () => {
  test("the idle limit the description teaches is the one enforced", () => {
    // The description tells the model a number, and the model plans around it:
    // heartbeat() calls are placed to beat that clock. If the enforced limit
    // moved and this sentence did not, the advice would be actively wrong.
    expect(RUN_DESCRIPTION).toContain(`${GeeService.GeeExecutor.IDLE_FLOOR_SECONDS}s idle timeout`)
    expect(RUN_DESCRIPTION).toContain("FORCE-KILL")
  })

  test("the description names only helpers the library actually exports", () => {
    // The import line it teaches is copy-pasted verbatim into scripts. A name
    // that drifted out of the library would fail at import, before the script
    // did anything at all.
    for (const helper of ["init_gee", "load_region", "check_coverage", "heartbeat", "download_image", "export_image"]) {
      expect(RUN_DESCRIPTION).toContain(helper)
    }
  })
})
