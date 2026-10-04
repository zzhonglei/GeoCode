export * as Qgis from "./index.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Option, PubSub, Schema, Stream } from "effect"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"
import { Macos } from "./macos.ts"
import { Python } from "./python.ts"

const DOMAIN = "qgis"

/** Generous: the probe only has to finish, and a first start from a cold disk is slow. */
const PROBE_TIMEOUT = "2 minutes"

/** How long a run waits for a check in progress; longer than the probe may take. */
const SETTLE_TIMEOUT = "150 seconds"

const SPOTLIGHT_TIMEOUT = "10 seconds"

const DEFAULT_IDLE_SECONDS = 600
const MIN_IDLE_SECONDS = 30
const MAX_IDLE_SECONDS = 24 * 60 * 60

/** Characters kept of output nobody parses, for the diagnostics. */
const OUTPUT_TAIL = 16 * 1024

/** Characters held while waiting for the end of a line; longer output without one is noise. */
const LINE_LIMIT = 1024 * 1024

/** Messages an algorithm reported, kept for its result; all of them reach the caller as progress. */
const MESSAGE_LIMIT = 200

const Block = Schema.Struct({ path: Schema.String })

// The failure first: a processing failure carries every field a success does.
const Report = Schema.Union([
  Schema.Struct({
    python: Schema.String,
    failed: Schema.Literals(["gdal", "proj", "core", "processing"]),
    error: Schema.String,
  }),
  Schema.Struct({ python: Schema.String, gdal: Schema.String, qgis: Schema.String, algorithms: Schema.Number }),
])

const RunParams = Schema.Struct({
  algorithm: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  cwd: Schema.optionalKey(Schema.String),
  idleTimeoutSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_IDLE_SECONDS, exclusiveMinimum: true })),
  ),
})

const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), percent: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("message"), level: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("result"),
    ok: Schema.Boolean,
    outputs: Schema.optionalKey(Schema.Unknown),
    stage: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
])

const decodeBlock = Schema.decodeUnknownExit(Block)
const decodeReport = Schema.decodeUnknownExit(Report)
const decodeRunParams = Schema.decodeUnknownExit(RunParams)
const decodeEvent = Schema.decodeUnknownExit(Event)

export type Failed =
  | "config-error"
  | "platform-unsupported"
  | "path-missing"
  | "not-qgis"
  | "unsupported"
  | "gdal-missing"
  | "proj-broken"
  | "core-missing"
  | "processing-failed"
  | "probe-timeout"
  | "probe-failed"

/** The facts for locating a problem, for the interface to present. */
export interface Diagnostics {
  readonly message: string
  /** machine.json, when it is the file at fault. */
  readonly file?: string
  /** The configured QGIS path. */
  readonly path?: string
  readonly app?: string
  readonly version?: string
  readonly interpreter?: string
  readonly output?: string
}

export type State =
  | { readonly status: "unconfigured"; readonly hint: string }
  | { readonly status: "checking"; readonly path: string }
  | {
      readonly status: "ready"
      readonly app: string
      readonly interpreter: string
      readonly version: string | undefined
      readonly versions: { readonly qgis: string; readonly gdal: string; readonly python: string }
      readonly algorithms: number
    }
  | { readonly status: Failed; readonly diagnostics: Diagnostics; readonly hint: string }

/** What GeoAgent should do next, by state. */
const HINTS: Record<Failed | "unconfigured", string> = {
  unconfigured:
    'QGIS is not configured. Ask the user for the location of their QGIS installation and set "qgis": { "path": ... } in machine.json.',
  "config-error": "machine.json cannot be read. Ask the user to fix the file at the reported location.",
  "platform-unsupported": "GeoCode cannot run QGIS on this operating system. Tell the user QGIS tools are unavailable.",
  "path-missing": "The configured QGIS path does not exist. Ask the user where QGIS is installed.",
  "not-qgis": "The configured path is not a QGIS installation. Ask the user for the path of the QGIS app.",
  unsupported:
    "This QGIS release is not supported. GeoCode supports the official QGIS 3.44 LTR and 4.x packages; suggest installing one.",
  "gdal-missing": "QGIS's Python cannot load GDAL; the installation is incomplete. Suggest reinstalling QGIS.",
  "proj-broken":
    "QGIS cannot transform coordinates; its projection data is missing or broken. Suggest reinstalling QGIS.",
  "core-missing": "QGIS's Python cannot load QGIS itself; the installation is incomplete. Suggest reinstalling QGIS.",
  "processing-failed":
    "QGIS loads but its Processing framework does not start, so no algorithm can run. Suggest reinstalling QGIS.",
  "probe-timeout":
    "Checking QGIS took too long; the computer may be busy. Ask the user to check again under Settings, Geo environment.",
  "probe-failed": "QGIS's Python failed while being checked. Suggest reinstalling QGIS and report the diagnostics.",
}

const failed = (status: Failed, diagnostics: Diagnostics): State => ({ status, diagnostics, hint: HINTS[status] })

export const capability: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  const config = yield* Config.Service
  const runtime = yield* Runtime.Service
  const block = yield* config.block(DOMAIN, Block)
  const writer = yield* status.register<State>(DOMAIN, settledOrChecking(yield* block.current))

  const probe = (configured: string, install: Macos.Install) =>
    runtime
      .run({
        command: install.interpreter,
        args: ["-c", Python.PROBE],
        env: Macos.environment(install),
        delivery: { mode: "collect" },
        clocks: { total: PROBE_TIMEOUT },
      })
      .pipe(
        Effect.map((result) => judge(configured, install, result)),
        Effect.catch((error) =>
          Effect.succeed(failed("probe-failed", { ...where(configured, install), message: error.message })),
        ),
      )

  /** Undefined when the check was stopped, as at shutdown, which says nothing about QGIS. */
  const inspect = (configured: string) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") {
        return failed("platform-unsupported", { message: `no QGIS support for ${process.platform}`, path: configured })
      }
      const located = yield* Effect.promise(() => Macos.locate(configured))
      if (!located.ok) {
        return failed(located.status, {
          message: located.message,
          path: configured,
          app: located.app,
          version: located.version,
        })
      }
      return yield* probe(configured, located.install)
    })

  const check = (state: Config.BlockState<typeof Block.Type>) =>
    Effect.gen(function* () {
      const token = yield* writer.claim()
      const settled = settledOrChecking(state)
      yield* writer.commit(token, settled)
      if (settled.status !== "checking") return
      // An unexpected error would otherwise end the watch for good, leaving the domain checking forever.
      const next = yield* inspect(settled.path).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(failed("probe-failed", { message: Cause.pretty(cause), path: settled.path })),
        ),
      )
      if (next) yield* writer.commit(token, next)
    })

  // Subscribed now, so a recheck asked for right after startup is not lost.
  const rechecks = yield* PubSub.unbounded<void>()
  const asked = yield* PubSub.subscribe(rechecks)
  const triggers = Stream.merge(block.watch, Stream.fromSubscription(asked).pipe(Stream.mapEffect(() => block.current)))
  // A new configuration or recheck interrupts the check still running, ending its probe.
  yield* Effect.forkScoped(Stream.runDrain(Stream.switchMap(triggers, (state) => Stream.fromEffect(check(state)))))

  const discover: Engine.Method = (_raw, context) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return { installs: [] }
      // Spotlight may be off or still indexing; the application folders are listed regardless.
      const spotlight = yield* runtime
        .run({
          command: "/usr/bin/mdfind",
          args: [Macos.SPOTLIGHT_QUERY],
          delivery: { mode: "collect" },
          clocks: { total: SPOTLIGHT_TIMEOUT },
          signal: context.signal,
        })
        .pipe(
          Effect.map((result) => (result.reason === "exit" && result.code === 0 ? result.stdout.split("\n") : [])),
          Effect.catch(() => Effect.succeed([])),
        )
      return { installs: yield* Effect.promise(() => Macos.installs(spotlight.filter(Boolean))) }
    })

  const configure: Engine.Method = (raw) =>
    Effect.gen(function* () {
      const decoded = decodeBlock(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      if (!path.isAbsolute(decoded.value.path)) {
        return yield* new Engine.Failure({
          code: "invalid-params",
          message: `${decoded.value.path} is not an absolute path`,
        })
      }
      // Refused before the write, whose own message would carry the file's location.
      if (!(yield* block.current).ok) {
        return yield* new Engine.Failure({
          code: "config-unreadable",
          message: "machine.json cannot be read, so it is left as it is",
        })
      }
      // The write reaches the watch, which starts the check.
      yield* block
        .write({ path: decoded.value.path })
        .pipe(Effect.mapError((error) => new Engine.Failure({ code: "write-failed", message: error.message })))
      return {}
    })

  const recheck: Engine.Method = () => PubSub.publish(rechecks, undefined).pipe(Effect.as({}))

  const run: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeRunParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const params = decoded.value
      // Checked here, or a missing one reads as a missing interpreter.
      const cwd = params.cwd
      if (cwd !== undefined && !(yield* Effect.promise(() => isDirectory(cwd)))) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${cwd} is not a directory` })
      }
      const current = yield* Effect.raceFirst(settledState(status), cancelled(context.signal))
      if (current?.status !== "ready") {
        return yield* new Engine.Failure({
          code: "not-ready",
          message: current && "hint" in current ? current.hint : "QGIS is still being checked.",
          details: current,
        })
      }
      const idle = Math.max(MIN_IDLE_SECONDS, params.idleTimeoutSeconds ?? DEFAULT_IDLE_SECONDS)
      return yield* execute(runtime, current, params, idle, context)
    })

  return { domain: DOMAIN, methods: { run, discover, configure, recheck } }
})

/** The state a configuration settles on at once, or `checking` when it names a QGIS to probe. */
function settledOrChecking(state: Config.BlockState<typeof Block.Type>): State {
  if (!state.ok) return failed("config-error", { message: state.failure.message, file: state.failure.file })
  if (state.value === undefined) return { status: "unconfigured", hint: HINTS.unconfigured }
  return { status: "checking", path: state.value.path }
}

/** Waits for a check in progress to settle, within a limit; undefined when it has not. */
function settledState(status: Status.Interface) {
  return status.watch(DOMAIN).pipe(
    Stream.map((value) => value as State),
    Stream.filter((state) => state.status !== "checking"),
    Stream.runHead,
    Effect.timeoutOption(SETTLE_TIMEOUT),
    Effect.map((found) => Option.getOrUndefined(Option.flatten(found))),
  )
}

/** Waits for an abort of the signal, and fails as a cancelled run. */
function cancelled(signal: AbortSignal) {
  return Effect.callback<never, Engine.Failure>((resume) => {
    const abort = () => resume(Effect.fail(new Engine.Failure({ code: "cancelled", message: "the run was cancelled" })))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}

function where(configured: string, install: Macos.Install) {
  return { path: configured, app: install.app, version: install.version, interpreter: install.interpreter }
}

function judge(configured: string, install: Macos.Install, result: Runtime.Result): State | undefined {
  if (result.reason === "abort") return
  const output = tail(`${result.stdout}\n${result.stderr}`.trim())
  if (result.reason === "timeout") {
    const message = `the check did not finish within ${PROBE_TIMEOUT}`
    return failed("probe-timeout", { ...where(configured, install), message, output })
  }
  const last = Python.marked(result.stdout).at(-1)
  const decoded = last === undefined ? undefined : decodeReport(last)
  if (!decoded || Exit.isFailure(decoded)) {
    const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
    const message = `QGIS's Python exited with ${ending} without a valid report`
    return failed("probe-failed", { ...where(configured, install), message, output })
  }
  const report = decoded.value
  if ("failed" in report) {
    const status = (
      { gdal: "gdal-missing", proj: "proj-broken", core: "core-missing", processing: "processing-failed" } as const
    )[report.failed]
    const message = `the ${report.failed} check failed`
    return failed(status, { ...where(configured, install), message, output: tail(report.error) })
  }
  return {
    status: "ready",
    app: install.app,
    interpreter: install.interpreter,
    version: install.version,
    versions: { qgis: report.qgis, gdal: report.gdal, python: report.python },
    algorithms: report.algorithms,
  }
}

async function isDirectory(target: string) {
  return fsp.stat(target).then(
    (stats) => stats.isDirectory(),
    () => false,
  )
}

function execute(
  runtime: Runtime.Interface,
  install: Macos.Install,
  params: typeof RunParams.Type,
  idle: number,
  context: Engine.MethodContext,
) {
  const messages: { readonly level: string; readonly text: string }[] = []
  let noise = ""
  let pending = ""
  let outcome: Extract<typeof Event.Type, { type: "result" }> | undefined

  const line = (text: string) => {
    const payload = Python.marked(text)[0]
    const decoded = payload === undefined ? undefined : decodeEvent(payload)
    if (!decoded || Exit.isFailure(decoded)) {
      if (text.trim()) noise = tail(`${noise}${text}\n`)
      return
    }
    const event = decoded.value
    if (event.type === "result") {
      outcome = event
      return
    }
    if (event.type === "message") {
      messages.push({ level: event.level, text: event.text })
      if (messages.length > MESSAGE_LIMIT) messages.shift()
    }
    context.progress(event.type === "progress" ? { percent: event.percent } : { level: event.level, text: event.text })
  }

  const onChunk = (chunk: string) => {
    const lines = (pending + chunk).split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const text of lines) line(text)
    if (pending.length <= LINE_LIMIT) return
    noise = tail(`${noise}${pending}`)
    pending = ""
  }

  return runtime
    .run({
      command: install.interpreter,
      args: ["-c", Python.RUN, JSON.stringify({ algorithm: params.algorithm, parameters: params.parameters })],
      cwd: params.cwd,
      env: Macos.environment(install),
      delivery: { mode: "incremental", onChunk },
      clocks: { idle: `${idle} seconds` },
      signal: context.signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) => {
        if (pending) line(pending)
        const details = { messages, stderr: tail(result.stderr), output: noise }
        if (result.reason === "abort") {
          return Effect.fail(new Engine.Failure({ code: "cancelled", message: "the run was cancelled", details }))
        }
        if (result.reason === "idle") {
          const message = `QGIS reported nothing for ${idle} seconds`
          return Effect.fail(new Engine.Failure({ code: "timeout", message, details }))
        }
        if (!outcome) {
          const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
          const message = `QGIS's Python exited with ${ending} before reporting a result`
          return Effect.fail(new Engine.Failure({ code: "crashed", message, details }))
        }
        if (!outcome.ok) {
          const message = outcome.error ?? "the algorithm failed"
          return Effect.fail(
            new Engine.Failure({ code: "algorithm-failed", message, details: { ...details, stage: outcome.stage } }),
          )
        }
        return Effect.succeed({ outputs: outcome.outputs, messages })
      }),
    )
}

function tail(text: string) {
  return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL)
}
