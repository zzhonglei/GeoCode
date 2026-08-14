import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Duration, Effect, Layer, PubSub, Ref, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { MachineConfig } from "@/geo/config"
import { GeeService } from "@/geo/gee"
import { GeeExecutor } from "@/geo/gee/executor"
import { GEOCODE_PY } from "@/geo/gee/scripts.generated"
import { GeeSetup } from "@/geo/gee/setup"
import type { Environment } from "@/geo/gee/types"
import { GeeValidate } from "@/geo/gee/validate"
import { GeoNet } from "@/geo/net"
import type { NetTypes } from "@/geo/net/types"
import { GeoRuntime } from "@/geo/runtime"
import { GeoStatus } from "@/geo/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

/* GEE execution and the runtime library (docs/GEOKERNEL.md §5.9, §5.10).
 *
 * The library is a faithful port of the one that survived production; the
 * whole point is that it is unchanged, so the test that matters is that the
 * generated constant still equals the source. The rest holds down the
 * injection: six things a script must not have to arrange for itself, an idle
 * clock rather than a total one, and a return shape that keeps the streamed
 * output separate from the agent-facing facts. */

const FILE = path.join(Global.Path.config, "machine.json")
const write = (value: object) => Effect.promise(() => fs.promises.writeFile(FILE, JSON.stringify(value), "utf-8"))
const clear = Effect.promise(() => fs.promises.rm(FILE, { force: true }))
// The config directory is shared across test files; leaving a configuration
// behind would decide another file's starting state.
afterAll(() => fs.rmSync(FILE, { force: true }))

const home = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-x-"))
const python = path.join(home, "python3")
fs.writeFileSync(python, "")

const environment: Environment = {
  python,
  project: "demo-project",
  version: "1.7.24",
  route: "proxy:127.0.0.1:7890",
  env: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1,::1" },
}

describe("gee runtime library", () => {
  test("the generated constant matches the source", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "src", "geo", "gee", "pylib", "geocode.py"),
      "utf8",
    )
    if (source !== GEOCODE_PY) {
      throw new Error("geocode.py is out of sync — run: bun run script/gen-geo-scripts.ts")
    }
  })

  test("the ported surface is intact", () => {
    // The library is a port, not a rewrite (§5.10). These are the entry points
    // scripts are told to use, plus the three heartbeat forms the idle clock
    // depends on — if any went missing in the port, scripts written against
    // the documented surface would fail at import time.
    for (const name of ["init_gee", "load_region", "export_image", "check_coverage", "download_image", "heartbeat"]) {
      expect(GEOCODE_PY).toContain(`def ${name}(`)
    }
    for (const form of ["_Heartbeat", "_FileHeartbeat", "_GeedimProgressHeartbeat"]) {
      expect(GEOCODE_PY).toContain(`class ${form}`)
    }
    // The behaviours the design calls out by name, each one a decision rather
    // than an implementation detail (§5.10).
    expect(GEOCODE_PY).toContain("load_region expects exactly one feature")
    expect(GEOCODE_PY).toContain("ee.Image.constant(1)")
    expect(GEOCODE_PY).toContain("shutil.move")
    expect(GEOCODE_PY).toContain("Task ID:")
    // And no reference to a config file that no longer exists.
    expect(GEOCODE_PY).not.toContain("geocode.json")

    // The three missing-package hints name the tool to call again.
    //
    // They are read by the AGENT at the one moment they fire: a script just
    // died on an absent import, the agent installs the package, and the hint's
    // closing promise — usable immediately, no restart — is only actionable if
    // it says WHAT to call. The port had generalised these to "retry the
    // script", which names nothing: the agent may be holding an inline string
    // or a path, and "the script" points at neither tool nor file.
    //
    // Worth pinning because the rule that produced the generalisation is real
    // but belongs elsewhere: §11.2 took tool names OUT of the QGIS runner,
    // which the kernel generates and the tool layer can annotate afterwards.
    // This library is imported BY the user's script and raises inside Python,
    // where no layer above can add anything — so here the name has to be in
    // the string itself.
    // Counted, not merely present: there are three such hints (geopandas,
    // geemap, geedim) and the port had generalised all three at once.
    expect(GEOCODE_PY.match(/retry the RunGeeScript call/g)).toHaveLength(3)
  })
})

const systemPython = ["python3", "python"].find(
  (candidate) => Bun.spawnSync([candidate, "--version"], { stdout: "pipe", stderr: "pipe" }).success,
)

describe.skipIf(!systemPython)("gee export, at each terminal state", () => {
  test("only COMPLETED returns — every other ending raises", () => {
    // The runtime library had no execution coverage at all; everything about it
    // was asserted as strings, and "does it raise" is not a question a string
    // can answer. It is also the only question the tool layer asks:
    // `geo-gee-run.ts` decides success from the exit code, so an export that
    // ended FAILED and returned normally reached the Agent as a completed run
    // — no error_code, nothing marked failed, a file reported that is not on
    // anyone's Drive.
    //
    // The shipping module is executed rather than a copy of it: `import ee`
    // happens inside the function, so a fake in sys.modules runs the real thing
    // on any python3, with no Earth Engine account and no network.
    const run = Bun.spawnSync(
      [
        systemPython!,
        path.join(import.meta.dir, "fixtures", "gee-export-answer.py"),
        path.join(import.meta.dir, "..", "..", "src", "geo", "gee", "pylib", "geocode.py"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (!run.success) throw new Error(`gee-export-answer.py failed:\n${run.stderr.toString()}`)
    // The function prints progress before answering, so the payload is the last line.
    const answers = JSON.parse(run.stdout.toString().trim().split("\n").pop()!) as Record<
      string,
      { outcome: string; message?: string }
    >

    expect(answers.COMPLETED!.outcome).toBe("returned")
    // CANCELLED among them: someone stopping the task from the Code Editor is
    // not an error, but it is not an export either, and the one thing the Agent
    // must not do is report a file that is not there.
    for (const state of ["FAILED", "CANCELLED", "UNKNOWN"]) expect(answers[state]!.outcome, state).toBe("raised")

    // With the reason, and with the id that outlives the script — the export
    // itself keeps running service-side, and that id is how a user reaches it.
    expect(answers.FAILED!.message).toContain("quota exhausted")
    for (const state of ["FAILED", "CANCELLED", "UNKNOWN"]) expect(answers[state]!.message, state).toContain("T-fake")
  })
})

describe("gee library materialization", () => {
  test("the module lands under a content-hashed directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-lib-"))
    try {
      const first = GeeExecutor.ensureLibrary(dir, "X = 1\n")
      // The file name is fixed — `from geocode import …` requires it — so the
      // hash has to live one level up.
      expect(path.basename(first)).toMatch(/^[0-9a-f]{8}$/)
      expect(fs.readFileSync(path.join(first, "geocode.py"), "utf8")).toBe("X = 1\n")

      expect(GeeExecutor.ensureLibrary(dir, "X = 1\n")).toBe(first)
      const second = GeeExecutor.ensureLibrary(dir, "X = 2\n")
      expect(second).not.toBe(first)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("gee execution", () => {
  const captured: GeoRuntime.Options[] = []
  const runtimeLayer = Layer.mock(GeoRuntime.Service)({
    run: (options) =>
      Effect.sync(() => {
        captured.push(options)
        return {
          code: 0,
          reason: "exit",
          stdout: "",
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result
      }),
    killAllSync: () => {},
  })
  const it = testEffect(LayerNode.compile(LayerNode.group([GeoRuntime.node]), [[GeoRuntime.node, runtimeLayer]]))

  it.effect("the injection carries all six things a script must not arrange itself", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const outcome = yield* GeeExecutor.run(runtime, environment, {
        script: "print(1)",
        onChunk: () => Effect.void,
        cwd: "/work",
      })

      const options = captured.at(-1)!
      const env = options.env!
      // 1. the resolved route, so remote traffic follows what Net decided
      expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
      // 2. the project, so no script hardcodes it
      expect(env.GEE_PROJECT).toBe("demo-project")
      // 3. the library path, so `from geocode import …` resolves
      expect(env.PYTHONPATH!.split(path.delimiter)[0]).toMatch(/gee-runtime/)
      // 4. the fault handler, which we cannot insert into a script we did not write
      expect(env.PYTHONFAULTHANDLER).toBe("1")
      // 5. and 6. the encoding pair, so non-English output survives the pipe
      expect(env.PYTHONUTF8).toBe("1")
      expect(env.PYTHONIOENCODING).toBe("UTF-8")
      expect(options.cwd).toBe("/work")

      // The streamed output and the facts stay apart: the outcome hands back
      // the raw result plus the environment, and never a rendered string
      // (§9.1 第二条硬性形态).
      expect(outcome.mode).toBe("inline")
      expect(outcome.environment).toBe(environment)
      expect(Object.keys(outcome)).toEqual(["result", "environment", "mode"])
    }),
  )

  it.effect("an idle clock, floored, because long calls are silent by nature", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const idles: number[] = []
      for (const idleSeconds of [undefined, 5, 900]) {
        yield* GeeExecutor.run(runtime, environment, { script: "x", onChunk: () => Effect.void, idleSeconds })
        idles.push(Duration.toMillis(captured.at(-1)!.clocks.idle!))
      }
      // Default, floored, honoured. A total clock could not work here: a
      // single remote call legitimately runs for hours, and the heartbeat in
      // the runtime library is what makes an idle clock safe (§5.9 心跳契约).
      //
      // The floor is twice the library's heartbeat interval, and that is what
      // it is FOR: a caller asking for 5 seconds — or for 30, which is the
      // interval itself — would kill scripts that are heartbeating exactly as
      // documented, which is the one thing the contract promises works.
      expect(GeeExecutor.IDLE_FLOOR_SECONDS).toBeGreaterThan(GeeExecutor.HEARTBEAT_INTERVAL_SECONDS)
      expect(idles).toEqual([60_000, 60_000, 900_000])
      expect(captured.at(-1)!.clocks.total).toBeUndefined()
    }),
  )

  it.effect("a file run passes the path, an inline run passes the source", () =>
    Effect.gen(function* () {
      const runtime = yield* GeoRuntime.Service
      const file = yield* GeeExecutor.run(runtime, environment, {
        scriptPath: "/scripts/ndvi.py",
        onChunk: () => Effect.void,
      })
      expect(file.mode).toBe("file")
      expect(captured.at(-1)!.args).toEqual(["/scripts/ndvi.py"])

      yield* GeeExecutor.run(runtime, environment, { script: "print(2)", onChunk: () => Effect.void })
      expect(captured.at(-1)!.args).toEqual(["-c", "print(2)"])
    }),
  )
})

describe("gee gate", () => {
  const SETUP_OK = `${GeeSetup.MARKER}${JSON.stringify({ missing: [], credentials: true, version: "1.7.24" })}`
  const VALID = `${GeeValidate.MARKER}${JSON.stringify({ ok: true })}`
  const REJECTED = `${GeeValidate.MARKER}${JSON.stringify({ ok: false, message: "Project 'projects/x' not found" })}`

  function graph(validateOutput: string) {
    const hub = PubSub.unbounded<NetTypes.Reachability>().pipe(Effect.runSync)
    const runtimeLayer = Layer.mock(GeoRuntime.Service)({
      run: (options) =>
        Effect.succeed({
          code: 0,
          reason: "exit",
          stdout: options.label === "gee:setup" ? SETUP_OK : validateOutput,
          stderr: "",
          durationMs: 1,
          truncated: false,
          drainIncomplete: false,
        } satisfies GeoRuntime.Result),
      killAllSync: () => {},
    })
    const netLayer = Layer.succeed(
      GeoNet.Service,
      GeoNet.Service.of({
        register: () => Effect.void,
        status: () => Effect.succeed({ state: "idle" } as NetTypes.Reachability),
        watch: () => Stream.unwrap(Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)),
        route: () => Effect.succeed({ kind: "proxy", url: "http://127.0.0.1:7890" } as NetTypes.Route),
        proxy: () => Effect.succeed(undefined),
      }),
    )
    const it = testEffect(
      LayerNode.compile(LayerNode.group([GeeService.node, EventV2.node, MachineConfig.node, GeoStatus.node]), [
        [GeoRuntime.node, runtimeLayer],
        [GeoNet.node, netLayer],
      ]),
    )
    return { it, hub }
  }

  const settle = (hub: PubSub.PubSub<NetTypes.Reachability>) =>
    Effect.gen(function* () {
      const config = yield* MachineConfig.Service
      const status = yield* GeoStatus.Service
      yield* clear
      yield* write({ gee: { python, project: "demo-project" } })
      yield* config.reload()
      yield* pollWithTimeout(
        Effect.map(status.current("gee"), (s) => (s?.setup.status === "ready" ? s : undefined)),
        "setup never reached ready",
        "15 seconds",
      )
      yield* PubSub.publish(hub, { state: "reachable", route: "proxy:127.0.0.1:7890" })
      yield* pollWithTimeout(
        Effect.map(status.current("gee"), (s) => (s?.network.status === "reachable" ? s : undefined)),
        "never became reachable",
        "15 seconds",
      )
    })

  {
    const { it, hub } = graph(VALID)
    it.live(
      "an open gate hands out a verified environment, never a status to look up",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* settle(hub)

          const gate = yield* gee.gate()
          expect(gate.ok).toBe(true)
          if (gate.ok) {
            // Everything the executor needs, as one object handed over — so
            // nothing can change between "cleared" and "started" (§9.1, §4.9).
            expect(gate.environment.python).toBe(python)
            expect(gate.environment.project).toBe("demo-project")
            expect(gate.environment.version).toBe("1.7.24")
            expect(gate.environment.route).toBe("proxy:127.0.0.1:7890")
            expect(gate.environment.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
          }
        }),
      { timeout: 30000 },
    )
  }

  {
    const { it, hub } = graph(REJECTED)
    it.live(
      "a shut gate carries the composed status, not three separate stories",
      () =>
        Effect.gen(function* () {
          const gee = yield* GeeService.Service
          yield* settle(hub)

          const gate = yield* gee.gate()
          expect(gate.ok).toBe(false)
          if (!gate.ok) {
            // One verdict, pointing at the layer actually in the way (§5.6).
            expect(gate.status.facing).toBe("runtime")
            expect(gate.status.runtime.status).toBe("failed")
            expect(gate.status.setup.status).toBe("ready")
          }
        }),
      { timeout: 30000 },
    )
  }
})
