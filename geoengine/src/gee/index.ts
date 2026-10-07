export * as Gee from "./index.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Option, PubSub, Schema, Stream } from "effect"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"
import { Python } from "./python.ts"

const DOMAIN = "gee"

/** Generous: initializing and one minimal computation only have to finish, on a slow connection too. */
const CHECK_TIMEOUT = "90 seconds"

/** How long a run waits for a check in progress; longer than the check may take. */
const SETTLE_TIMEOUT = "100 seconds"

/**
 * How long a run may go with no output and no request waiting for Earth Engine. A waiting request reports every few
 * seconds, so only the script's own work counts, such as reading a large file.
 */
const IDLE_SECONDS = 120

/** Characters kept of what a run printed, the latest; the kernel cuts what it hands GeoAgent further. */
const OUTPUT_LIMIT = 1024 * 1024

/** Characters kept of output nobody parses, for the diagnostics. */
const OUTPUT_TAIL = 16 * 1024

/** Characters held while waiting for the end of a line; longer output without one is passed on as it is. */
const LINE_LIMIT = 64 * 1024

/** Lines of an error GeoAgent is given. */
const PRINTED_LINES = 20

const Block = Schema.Struct({ python: Schema.String, project: Schema.optionalKey(Schema.String) })

const Report = Schema.Struct({
  python: Schema.String,
  ee: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(Schema.Literals(["import", "earthengine"])),
  error: Schema.optionalKey(Schema.String),
  traceback: Schema.optionalKey(Schema.String),
})

/** Inline or from a file, never both; `cwd` is the session's directory. */
const RunParams = Schema.Union([
  Schema.Struct({ script: Schema.String, cwd: Schema.String }),
  Schema.Struct({ file: Schema.String, cwd: Schema.String }),
])

const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("begin") }),
  Schema.Struct({ type: Schema.Literal("waiting"), seconds: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("initialize-failed"), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("end"), ok: Schema.Boolean }),
])

const decodeBlock = Schema.decodeUnknownExit(Block)
const decodeReport = Schema.decodeUnknownExit(Report)
const decodeRunParams = Schema.decodeUnknownExit(RunParams)
const decodeEvent = Schema.decodeUnknownExit(Event)

export type Failed =
  | "config-error"
  | "python-missing"
  | "packages-missing"
  | "project-missing"
  | "check-timeout"
  | "check-failed"

/** The facts for locating a problem. */
export interface Diagnostics {
  readonly message: string
  /** machine.json, when it is the file at fault. */
  readonly file?: string
  readonly python?: string
  readonly project?: string
  /** What the Python printed, when the check ended without a report or did not finish. */
  readonly output?: string
  /** Where the failure the check reported arose. */
  readonly traceback?: string
}

export type State =
  | { readonly status: "unconfigured" }
  | { readonly status: "checking"; readonly python: string; readonly project?: string }
  | {
      readonly status: "ready"
      readonly python: string
      readonly project: string
      readonly versions: { readonly python: string; readonly ee: string }
    }
  | { readonly status: Failed; readonly diagnostics: Diagnostics }

type Ready = Extract<State, { readonly status: "ready" }>

/**
 * What looking at the Python and Earth Engine found, which can change with nothing in machine.json changing, as when a
 * package is installed or the user signs in; each tool call checks again.
 */
const RECHECKED: ReadonlySet<State["status"]> = new Set([
  "python-missing",
  "packages-missing",
  "check-timeout",
  "check-failed",
])

const failed = (status: Failed, diagnostics: Diagnostics): State => ({ status, diagnostics })

export const capability: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  const config = yield* Config.Service
  const runtime = yield* Runtime.Service
  const block = yield* config.block(DOMAIN, Block)
  const writer = yield* status.register<State>(DOMAIN, settledOrChecking(yield* block.current))

  /** Undefined when the check was stopped, as at shutdown, which says nothing about the environment. */
  const inspect = (python: string, project: string | undefined) =>
    runtime
      .run({
        command: python,
        args: ["-"],
        input: Python.program(Python.CHECK, { project: project ?? null }),
        env: Python.ENVIRONMENT,
        delivery: { mode: "collect" },
        clocks: { total: CHECK_TIMEOUT },
      })
      .pipe(
        Effect.map((result) => judge(python, project, result)),
        // A Python that cannot be started fails here, before it has a pid or, on Windows, just after.
        Effect.catch((error) => Effect.succeed(failed("python-missing", { python, project, message: error.message }))),
      )

  const check = (state: Config.BlockState<typeof Block.Type>) =>
    Effect.gen(function* () {
      const token = yield* writer.claim()
      const settled = settledOrChecking(state)
      yield* writer.commit(token, settled)
      if (settled.status !== "checking") return
      // An unexpected error would otherwise end the watch for good, leaving the domain checking forever.
      const next = yield* inspect(settled.python, settled.project).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(failed("check-failed", { message: Cause.pretty(cause), python: settled.python })),
        ),
      )
      if (next) yield* writer.commit(token, next)
    })

  // Subscribed now, so a recheck asked for right after startup is not lost.
  const rechecks = yield* PubSub.unbounded<void>()
  const asked = yield* PubSub.subscribe(rechecks)
  // The file is read again first: its watch may have died, and then the configuration in memory is stale.
  const triggers = Stream.merge(
    block.watch,
    Stream.fromSubscription(asked).pipe(Stream.mapEffect(() => config.reload().pipe(Effect.andThen(block.current)))),
  )
  // A new configuration or recheck interrupts the check still running, ending its Python.
  yield* Effect.forkScoped(Stream.runDrain(Stream.switchMap(triggers, (state) => Stream.fromEffect(check(state)))))

  // The state a recheck was last asked from. Calls that find the same one ask once: a second ask would restart the
  // check, killing a Python that may have begun while the file was read again.
  let rechecked: State | undefined

  /**
   * The ready environment, once a check in progress settles; otherwise the state and what GeoAgent should do about it.
   * A state found by looking at the environment is checked again first; calls arriving once it has begun find it
   * checking and wait for it. Without a Python to look at, or a project, the file is read again instead, since GeoAgent
   * is told it takes effect as soon as it is saved.
   */
  const ready = (signal: AbortSignal) =>
    Effect.gen(function* () {
      const found = (yield* status.current(DOMAIN)) as State
      let stale = RECHECKED.has(found.status) ? found : undefined
      if (stale && rechecked !== stale) {
        rechecked = stale
        yield* PubSub.publish(rechecks, undefined)
      } else if (
        found.status === "unconfigured" ||
        found.status === "config-error" ||
        found.status === "project-missing"
      ) {
        // By the block's state itself, which a read replaces only when the block changed: a missing project is found by
        // the check, never by reading the file, so the states cannot be compared.
        const before = yield* block.current
        yield* config.reload()
        if ((yield* block.current) !== before) stale = found
      }
      const current = yield* Effect.raceFirst(settledState(status, stale), cancelled(signal))
      if (current?.status !== "ready") {
        return yield* new Engine.Failure({
          code: "not-ready",
          message: current ? hint(current, config.file) : "Google Earth Engine is still being checked.",
          details: current,
        })
      }
      return current
    })

  const recheck: Engine.Method = () => PubSub.publish(rechecks, undefined).pipe(Effect.as({}))

  /** Runs GeoAgent's script in the configured Python, ending it after IDLE_SECONDS with neither output nor a wait. */
  const run: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeRunParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const params = decoded.value
      if (!path.isAbsolute(params.cwd) || !(yield* Effect.promise(() => isKind(params.cwd, "directory")))) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${params.cwd} is not a directory` })
      }
      if (
        "file" in params &&
        (!path.isAbsolute(params.file) || !(yield* Effect.promise(() => isKind(params.file, "file"))))
      ) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${params.file} is not a file` })
      }
      const current = yield* ready(context.signal)
      return yield* execute(runtime, current, params, context)
    })

  return { domain: DOMAIN, methods: { run, recheck } }
})

/** The state a configuration settles on at once, or `checking` when it names a Python to look at. */
function settledOrChecking(state: Config.BlockState<typeof Block.Type>): State {
  if (!state.ok) return failed("config-error", { message: state.failure.message, file: state.failure.file })
  if (state.value === undefined) return { status: "unconfigured" }
  const python = state.value.python
  const project = state.value.project
  return project === undefined ? { status: "checking", python } : { status: "checking", python, project }
}

/** Waits for a check in progress, or one replacing `stale`, to settle, within a limit; undefined when it has not. */
function settledState(status: Status.Interface, stale?: State) {
  return status.watch(DOMAIN).pipe(
    Stream.map((value) => value as State),
    Stream.filter((state) => state.status !== "checking" && state !== stale),
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

function judge(python: string, project: string | undefined, result: Runtime.Result): State | undefined {
  if (result.reason === "abort") return
  const where = { python, ...(project === undefined ? {} : { project }) }
  const printed = tail(`${result.stdout}\n${result.stderr}`.trim())
  if (result.reason === "timeout") {
    return failed("check-timeout", {
      ...where,
      message: `the check did not finish within ${CHECK_TIMEOUT}`,
      output: printed,
    })
  }
  const last = Python.marked(result.stdout).at(-1)
  const decoded = last === undefined ? undefined : decodeReport(last)
  if (!decoded || Exit.isFailure(decoded)) {
    const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
    const message = `the Python exited with ${ending} without a report`
    return failed("check-failed", { ...where, message, output: printed })
  }
  const report = decoded.value
  if (report.failed === "import") {
    return failed("packages-missing", {
      ...where,
      message: report.error ?? "earthengine-api cannot be imported",
      traceback: report.traceback,
    })
  }
  if (report.failed === "earthengine") {
    return failed("check-failed", {
      ...where,
      message: report.error ?? "Earth Engine did not answer",
      traceback: report.traceback,
    })
  }
  if (project === undefined)
    return failed("project-missing", { ...where, message: "no Google Cloud project is configured" })
  return { status: "ready", python, project, versions: { python: report.python, ee: report.ee ?? "" } }
}

/**
 * What GeoAgent is told when Google Earth Engine is not ready: the facts, and what it can do itself and what only the
 * user can.
 */
export function hint(state: Exclude<State, Ready>, file: string): string {
  if (state.status === "checking") return "Google Earth Engine is still being checked."
  if (state.status === "config-error") {
    const at = state.diagnostics.file ?? file
    return `${at} cannot be read: ${state.diagnostics.message}. No geo tool works until it is fixed; it is checked as soon as the file is saved.`
  }
  const configured = `The configuration is the "gee" block of ${file}: {"python": "<absolute path of the Python>", "project": "<Google Cloud project ID>"}. It is checked as soon as the file is saved; then call geerun again.`
  if (state.status === "unconfigured") {
    return [
      "Google Earth Engine is not configured.",
      configured,
      "Find a Python on this computer that has earthengine-api installed, such as a conda environment, or ask the user which to use. Ask the user for the ID of their Google Cloud project registered for Earth Engine; never guess it.",
    ].join("\n")
  }
  const diagnostics = state.diagnostics
  const last = (text: string) => text.trim().split("\n").slice(-PRINTED_LINES).join("\n")
  if (state.status === "python-missing") {
    return [
      `The configured Python, ${diagnostics.python}, cannot be started: ${diagnostics.message}.`,
      configured,
    ].join("\n")
  }
  if (state.status === "packages-missing") {
    return [
      `The configured Python, ${diagnostics.python}, cannot import earthengine-api: ${diagnostics.message}`,
      "With the user's consent, install earthengine-api into that Python (from conda-forge for a conda environment), or configure another Python.",
      configured,
    ].join("\n")
  }
  if (state.status === "project-missing") {
    return [
      "No Google Cloud project is configured for Google Earth Engine.",
      'Ask the user for the ID of their Google Cloud project registered for Earth Engine, and write it as "project"; never guess it.',
      configured,
    ].join("\n")
  }
  if (state.status === "check-timeout") {
    return `Checking Google Earth Engine with ${diagnostics.python} took longer than ${CHECK_TIMEOUT}: the network may be slow or blocked. It is checked again the next time geerun is called.`
  }
  const project = diagnostics.project === undefined ? "" : `, and project, ${diagnostics.project}`
  // Without a report, GeoEngine's own message says only that there was none; what the Python printed says why.
  const printed = diagnostics.output ? [last(diagnostics.output)] : []
  return [
    `Google Earth Engine does not work with the configured Python, ${diagnostics.python}${project}: ${last(diagnostics.message)}`,
    ...printed,
    "If the error says the credentials are missing or invalid, the user must sign in: with their consent, run that Python environment's `earthengine authenticate`, which opens their browser. If it names the project, ask the user to check the project ID and that the project is registered for Earth Engine. If it cannot connect, the network is at fault, not the setup: do not reinstall or reconfigure anything.",
    "It is checked again the next time geerun is called.",
  ].join("\n")
}

function execute(
  runtime: Runtime.Interface,
  current: Ready,
  params: typeof RunParams.Type,
  context: Engine.MethodContext,
) {
  // What the script printed and its errors, both streams in the order they came, from its start: GeoAgent's answer.
  let output = ""
  let truncated = false
  // What came before the script started, from earthengine-api and the Python itself: for the diagnostics.
  let noise = ""
  // From the script's start on each stream: one can be read ahead of the other.
  const begun = { stdout: false, stderr: false }
  let ended: { readonly ok: boolean } | undefined
  let initializeError: string | undefined
  const pending = { stdout: "", stderr: "" }

  const keep = (text: string, stream: "stdout" | "stderr") => {
    if (!begun[stream]) {
      noise = tail(noise + text)
      return
    }
    output += text
    // Cut back with room to spare, not on every line past the limit, which would copy the whole output each time.
    if (output.length <= 2 * OUTPUT_LIMIT) return
    output = output.slice(-OUTPUT_LIMIT)
    truncated = true
  }

  const line = (text: string, stream: "stdout" | "stderr", newline: boolean) => {
    const payload = Python.markedLine(text)
    const decoded = payload === undefined ? undefined : decodeEvent(payload)
    if (!decoded || Exit.isFailure(decoded)) return keep(newline ? `${text}\n` : text, stream)
    const event = decoded.value
    if (event.type === "waiting") return context.progress({ waiting: event.seconds })
    if (event.type === "initialize-failed") {
      initializeError = event.error
      return
    }
    if (event.type === "end") {
      ended = { ok: event.ok }
      return
    }
    begun[stream] = true
    if (stream === "stdout") context.progress({ begun: true })
  }

  // Each stream breaks into lines of its own: a line one leaves unfinished is not finished by the other.
  const onChunk = (chunk: string, stream: "stdout" | "stderr") => {
    const lines = (pending[stream] + chunk).split(/\r?\n/)
    pending[stream] = lines.pop() ?? ""
    for (const text of lines) line(text, stream, true)
    if (pending[stream].length <= LINE_LIMIT) return
    keep(pending[stream], stream)
    pending[stream] = ""
  }

  const request =
    "file" in params
      ? { project: current.project, file: params.file }
      : { project: current.project, script: params.script }

  return runtime
    .run({
      command: current.python,
      args: ["-"],
      input: Python.program(Python.RUN, request),
      env: Python.ENVIRONMENT,
      cwd: params.cwd,
      delivery: { mode: "incremental", source: "all", onChunk },
      clocks: { idle: `${IDLE_SECONDS} seconds` },
      signal: context.signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          if (pending.stdout) line(pending.stdout, "stdout", false)
          if (pending.stderr) line(pending.stderr, "stderr", false)
          if (output.length > OUTPUT_LIMIT) {
            output = output.slice(-OUTPUT_LIMIT)
            truncated = true
          }
          if (result.reason === "abort") {
            return yield* new Engine.Failure({
              code: "cancelled",
              message: "the run was cancelled",
              details: { output, noise },
            })
          }
          if (initializeError !== undefined) {
            return yield* new Engine.Failure({
              code: "initialize-failed",
              message: initializeError,
              details: { noise },
            })
          }
          const exit = result.signal ? `signal ${result.signal}` : `code ${result.code}`
          const outcome =
            result.reason === "idle" ? "idle" : ended === undefined ? "crashed" : ended.ok ? "finished" : "failed"
          return {
            outcome,
            // A Python that ended before the script began left its reason among what it printed.
            output: begun.stdout || begun.stderr ? output : noise,
            truncated,
            durationMs: result.durationMs,
            ...(outcome === "crashed" ? { exit } : {}),
            ...(outcome === "idle" ? { idleSeconds: IDLE_SECONDS } : {}),
          }
        }),
      ),
    )
}

async function isKind(target: string, kind: "file" | "directory") {
  return fsp.stat(target).then(
    (stats) => (kind === "file" ? stats.isFile() : stats.isDirectory()),
    () => false,
  )
}

function tail(text: string) {
  return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL)
}
