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
import { statusHolding } from "./lib/geocode-status"

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

const seen: { rejected: string[]; rechecks: number } = { rejected: [], rechecks: 0 }

/** `reject` judges like the real one, or `auth_rejected` would be set on every failing script. */
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

/** A user who already granted `gee`, which is `ask` for GeoAgent; without it `execute` parks at the prompt. */
const GRANTED = { permission: "gee", pattern: "*", action: "allow" } as const

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
          .ask({ ...req, sessionID: SessionID.make("ses_gee_test"), ruleset: [...agent!.permission, GRANTED] })
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

  it.instance("is in the registry, and the grant actually covers its key", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("RunGeeScript")

      const allowed = yield* execute({ script: "print(1)" })
      expect(Exit.isSuccess(allowed)).toBe(true)
    }),
  )
})

describe("RunGeeScript, pre-spawn refusals", () => {
  const it = harness(runtimeEnding({}), open)

  it.instance("a malformed call is blamed on the call, and never on Earth Engine", () =>
    Effect.gen(function* () {
      const neither = yield* succeed({})
      expect(neither.output).toContain("Python was NOT invoked")
      expect(neither.output).toContain("on your end (the agent)")
      expect(neither.metadata.param_error).toBe(true)

      const both = yield* succeed({ script: "print(1)", script_path: "/tmp/x.py" })
      expect(both.output).toContain("exactly one is expected")
      expect(both.output).toContain("Python was NOT invoked")

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

  it.instance("a script path is resolved against the instance and asked for in worktree form", () =>
    Effect.gen(function* () {
      // Passed through raw, a relative script_path resolves against process.cwd(), so the existence check can vet a
      // different file than the one that runs.
      const instance = yield* InstanceState.context
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.all()).find((item) => item.id === "RunGeeScript")!
      fs.writeFileSync(path.join(instance.directory, "pipeline.py"), "print(1)")

      const asked: string[][] = []
      const record = (params: Record<string, unknown>) =>
        tool
          .execute(params, {
            sessionID: SessionID.make("ses_gee_path"),
            messageID: MessageID.make("msg_gee_path"),
            agent: "GeoAgent",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (req: any) => Effect.sync(() => void asked.push(req.patterns)),
          } as any)
          .pipe(Effect.timeout(5_000), Effect.exit)

      // Reaches the prompt only if it resolved against the instance; otherwise the existence check refuses first.
      yield* record({ script_path: "pipeline.py" })
      const fromRelative = asked.at(-1)!
      expect(fromRelative).toHaveLength(1)

      // Absolute: the same pattern, or one file would need two rules to cover it.
      yield* record({ script_path: path.join(instance.directory, "pipeline.py") })
      expect(asked.at(-1)).toEqual(fromRelative)

      // Worktree-relative rather than passed through, the form `read` asks with.
      expect(path.isAbsolute(fromRelative[0]!)).toBe(false)

      // An identifier rather than `title`'s prose, because a rule is written against this string.
      yield* record({ script: "print(1)" })
      expect(asked.at(-1)).toEqual(["inline_script"])
    }),
  )

  it.instance("no refusal claims a duration for a run that never happened", () =>
    Effect.gen(function* () {
      for (const params of [{}, { script: "x", script_path: "/tmp/y.py" }, { script_path: "/nope/z.py" }]) {
        const result = yield* succeed(params)
        expect(result.output).not.toContain("Elapsed:")
        expect(result.metadata.elapsed_ms).toBeUndefined()
      }
    }),
  )
})

describe("RunGeeScript, a local dead end costs the user nothing", () => {
  const withStatus = (gee: GeoEvent.GeeStatus | undefined) =>
    testEffect(
      LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [GeeService.node, open],
        [GeoRuntime.node, runtimeEnding({})],
        [GeoStatus.node, statusHolding({ gee })],
      ]),
    )

  const askedFor = Effect.fnUntraced(function* (params: Record<string, unknown>) {
    const registry = yield* ToolRegistry.Service
    const tool = (yield* registry.all()).find((item) => item.id === "RunGeeScript")!
    const asked: string[] = []
    const result = yield* tool
      .execute(params, {
        sessionID: SessionID.make("ses_dead_end"),
        messageID: MessageID.make("msg_dead_end"),
        agent: "GeoAgent",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req: any) => Effect.sync(() => void asked.push(req.permission)),
      } as any)
      // 10s like execute above: each case compiles the whole layer graph, which a busy machine can stretch past 5s.
      .pipe(Effect.timeout(10_000), Effect.exit)
    return { asked, result }
  })

  // Flipped by the test body, not by recheck, or the first call would recover on its own and prove nothing.
  let installed = false
  const it_recovers = testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node, GeoKernel.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [
        GeeService.node,
        Layer.succeed(
          GeeService.Service,
          GeeService.Service.of({
            gate: () =>
              Effect.succeed(installed ? { ok: true, environment: ENVIRONMENT } : { ok: false, status: SHUT }),
            recheck: () =>
              Effect.sync(() => {
                seen.rechecks += 1
                return true
              }),
            validate: () => Effect.succeed({ status: "unknown" }),
            reject: () => Effect.succeed(false),
          } as never),
        ),
      ],
      [GeoRuntime.node, runtimeEnding({})],
      [
        GeoStatus.node,
        Layer.succeed(
          GeoStatus.Service,
          GeoStatus.Service.of({
            current: (slot: string) =>
              Effect.succeed(slot === "gee" ? ((installed ? READY : SHUT) as never) : undefined),
            register: () =>
              Effect.succeed({
                claim: () => Effect.succeed({} as never),
                publish: () => Effect.succeed(true),
              } as never),
            snapshot: () => Effect.succeed({}),
            watch: () => Stream.empty,
          } as never),
        ),
      ],
    ]),
  )

  withStatus(SHUT).instance("a stopped local chain is reported without a prompt", () =>
    Effect.gen(function* () {
      const { asked, result } = yield* askedFor({ script: "print(1)" })
      expect(asked).toEqual([])
      expect(Exit.isSuccess(result)).toBe(true)
      if (!Exit.isSuccess(result)) throw new Error("refused")
      // The user loses the prompt, not the guidance.
      expect(result.value.metadata.error).toBe(true)
      expect(result.value.output).not.toBe("")
    }),
  )

  // Every failing setup state in the schema, all but checking and ready: the guarantee is the whole set.
  const SETUP_FAILURES: GeoEvent.GeeStatus["setup"][] = [
    { status: "unconfigured" },
    { status: "config-error", file: "/x/machine.json", message: "bad" },
    { status: "python-missing", python: "/x/py" },
    { status: "packages-missing", python: "/x/py", missing: ["geemap"] },
    { status: "packages-broken", python: "/x/py", pkg: "geemap", error: "boom" },
    { status: "credentials-missing", python: "/x/py" },
    { status: "project-missing" },
    { status: "probe-timeout" },
    { status: "probe-failed", error: "boom" },
  ]

  for (const setup of SETUP_FAILURES) {
    withStatus({
      facing: "setup",
      setup,
      network: { status: "idle" },
      runtime: { status: "unknown" },
    }).instance(`"${setup.status}" is answered without a prompt`, () =>
      Effect.gen(function* () {
        const { asked, result } = yield* askedFor({ script: "print(1)" })
        expect(asked).toEqual([])
        expect(Exit.isSuccess(result)).toBe(true)
        if (!Exit.isSuccess(result)) throw new Error("refused")
        // Guidance rather than an empty refusal: this call is how the agent reads the next setup step.
        expect(result.value.output.length).toBeGreaterThan(40)
      }),
    )
  }

  const CHECKING: GeoEvent.GeeStatus = {
    facing: "setup",
    setup: { status: "checking" },
    network: { status: "idle" },
    runtime: { status: "unknown" },
  }

  withStatus(CHECKING).instance("a probe still in flight is NOT short-circuited", () =>
    Effect.gen(function* () {
      // settledGeeGate waits checking out, so a dead-end check swallowing it turns a slow probe into a failure.
      const { asked } = yield* askedFor({ script: "print(1)" })
      expect(asked).toContain("gee")
    }),
  )

  it_recovers.instance("a user who just did what they were told is not told it again", () =>
    Effect.gen(function* () {
      // The SELF_HEALING states (gee/index.ts) are fixed without touching machine.json, so without geeLocalDeadEnd's
      // own recheck the stale verdict comes back forever.
      installed = false
      const first = yield* askedFor({ script: "print(1)" })
      expect(first.asked).toEqual([])
      // Without this the test still passes against a dead-end check that reads a stale verdict and never looks.
      expect(seen.rechecks).toBeGreaterThan(0)

      installed = true
      const second = yield* askedFor({ script: "print(1)" })
      expect(second.asked).toContain("gee")
    }),
  )

  withStatus(undefined).instance("an unknown status is not treated as a failure", () =>
    Effect.gen(function* () {
      const { asked } = yield* askedFor({ script: "print(1)" })
      expect(asked).toContain("gee")
    }),
  )
})

describe("RunGeeScript, a shut gate", () => {
  const it = harness(runtimeEnding({}), geeService({ ok: false, status: SHUT }))

  it.instance("a refusal carries the kernel's guidance, not a sentence of its own", () =>
    Effect.gen(function* () {
      const result = yield* succeed({ script: "print(1)" })
      expect(result.output).toContain("Step 3 of 4")
      expect(result.output).toContain("earthengine")
      expect(result.metadata.error).toBe(true)
      // Both halves: setup alone covers both a missing interpreter and a missing sign-in.
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
        // The tool exposes no timeout, so a banner that does not name heartbeat() sends the agent after a knob that
        // does not exist.
        expect(result.output).toContain("heartbeat()")
        expect(result.output).toContain(`${GeeService.GeeExecutor.IDLE_FLOOR_SECONDS}s`)
        expect(result.metadata.error_code).toBe("IdleTimeout")
        expect(result.metadata.timed_out).toBe(true)
        expect(result.output).toContain("working")
        expect(result.output).toContain("Elapsed:")
      }),
  )

  ending({ reason: "abort", code: null }, ["partial\n"]).instance("a cancelled run says the user cancelled it", () =>
    Effect.gen(function* () {
      // Upstream completes the call with whatever the tool returned, so silence files the user's own Esc under
      // "it failed".
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
        // terminationBanner is shared with the QGIS runner, and GEE runs its own Python.
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
        const result = yield* succeed({ script: "print(1)" })
        expect(result.output).toContain("never ran")
        expect(result.output).toContain("ENOENT")
        expect(result.output).toContain("gee.python")
        expect(result.output).not.toContain("segfault")
        expect(result.output).not.toContain("unexpectedly quit")
        // No process ran, so a footer would say the script ran and finished instantly.
        expect(result.output).not.toContain("Elapsed:")
        expect(result.metadata.elapsed_ms).toBeUndefined()
        expect(result.metadata.error_code).toBe("LaunchFailed")
        // The shut gate's flag, since the environment is what is in the way.
        expect(result.metadata.error).toBe(true)
        expect(result.metadata.env_error).toBeUndefined()
        // And not filed under the endings that mean it ran and stopped.
        expect(result.metadata.partial).toBeUndefined()
        expect(result.metadata.failed).toBeUndefined()
      }),
    { timeout: 20_000 },
  )

  ending(
    {
      reason: "exit",
      code: 1,
      stderr:
        "Traceback (most recent call last):\n  File \"<string>\", line 2, in <module>\nModuleNotFoundError: No module named 'sklearn'",
    },
    ["loading region\n"],
  ).instance("a failed run carries the environment it ran in, beside what Python said", () =>
    Effect.gen(function* () {
      const status = yield* GeoStatus.Service
      yield* status.register("gee", READY)

      const result = yield* succeed({ script: "import sklearn" })

      expect(result.output).toContain("<geo_env>")
      expect(result.output).toContain(ENVIRONMENT.python)
      expect(result.output).toContain("ModuleNotFoundError: No module named 'sklearn'")
      // Header first, so the environment frames everything after it.
      expect(result.output.indexOf("<geo_env>")).toBeLessThan(result.output.indexOf("ModuleNotFoundError"))

      // No install advice on top of those two facts: it is instruction crowding out reasoning.
      expect(result.output).not.toMatch(/pip install/i)
      expect(result.output).not.toMatch(/install it|you should|make sure to/i)
      expect(result.output).not.toMatch(/scikit-learn|opencv/i)

      expect(result.metadata.missing_module).toBe("sklearn")
      expect(result.metadata.error_code).toBe("ScriptFailed")
      expect(result.output).toContain("loading region")
      // The kernel still judges the stderr, and an import error is not the remote refusing.
      expect(seen.rejected).toHaveLength(1)
      expect(result.metadata.auth_rejected).toBeUndefined()
    }),
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

  ending({}, ["ok\n"]).instance("the environment header never mentions the proxy", () =>
    Effect.gen(function* () {
      // Non-direct on purpose: with the fixture's usual direct route this would pass against the code it forbids.
      const status = yield* GeoStatus.Service
      yield* status.register("gee", {
        ...READY,
        network: { status: "reachable", route: "proxy:127.0.0.1:7890" },
      })

      const result = yield* succeed({ script: "print('ok')" })

      // The header is really there, or the absences below prove nothing.
      expect(result.output).toContain("<geo_env>")
      expect(result.output).toContain(ENVIRONMENT.python)

      expect(result.output).not.toContain("proxy")
      expect(result.output).not.toContain("7890")
      expect(result.output).not.toMatch(/\broute\b/)
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
        // The kernel still sees the message and judges it itself.
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
      // A killed run's stderr was never the remote's answer, even when it mentions permission.
      const result = yield* succeed({ script: "print('long job')" })
      expect(seen.rejected).toHaveLength(0)
      expect(result.metadata.auth_rejected).toBeUndefined()
      expect(result.metadata.aborted).toBe(true)
    }),
  )
})

describe("RunGeeScript, output that does not fit", () => {
  const flood = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")

  harness(runtimeEnding({}, [flood, "\nFINAL ANSWER: 0.42\n"]), open).instance(
    "a flood keeps the tail and says it was cut",
    () =>
      Effect.gen(function* () {
        const result = yield* succeed({ script: "print(lots)" })
        expect(result.metadata.truncated).toBe(true)
        // The tail is where a script prints its result; upstream's own truncation keeps the head.
        expect(result.output).toContain("FINAL ANSWER: 0.42")
        expect(result.output).toContain("Elapsed:")
        expect(result.output).toContain("earlier output trimmed")
        expect(result.output).not.toContain("line 0 ")

        // Declaring truncated skips upstream's save of the full text, so the tool has to write it out itself.
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
    // A cold start, which without the wait makes every first call answer that Earth Engine is not ready.
    const gate = await Effect.runPromise(GeoTool.settledGeeGate(service([probing, probing, READY], false)))
    expect(gate.ok).toBe(true)
  })

  test("a settled refusal is returned at once, not waited on", async () => {
    seen.rechecks = 0
    const started = Date.now()
    const gate = await Effect.runPromise(GeoTool.settledGeeGate(service([SHUT, SHUT, SHUT], false)))
    expect(gate.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("the description and the code agree", () => {
  test("the idle limit the description teaches is the one enforced", () => {
    // The model paces heartbeat() calls by this number, so a stale one gets scripts killed.
    expect(RUN_DESCRIPTION).toContain(`${GeeService.GeeExecutor.IDLE_FLOOR_SECONDS}s idle timeout`)
    expect(RUN_DESCRIPTION).toContain("FORCE-KILL")
  })

  test("the description names only helpers the library actually exports", () => {
    // Scripts copy these names verbatim, so one that drifted out of gee/pylib/geocode.py fails at import.
    for (const helper of ["init_gee", "load_region", "check_coverage", "heartbeat", "download_image", "export_image"]) {
      expect(RUN_DESCRIPTION).toContain(helper)
    }
  })
})
