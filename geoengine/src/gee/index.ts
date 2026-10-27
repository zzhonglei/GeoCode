export * as Gee from "./index.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Option, PubSub, Schema, Stream } from "effect"
import { Bundled } from "../bundled.ts"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"
import { Library } from "./library.ts"
import { Python } from "./python.ts"
import { Quota } from "./quota.ts"

const DOMAIN = "gee"

/** The domain of GeoCode's Python environment, whose base GEE runs in. */
const ENVIRONMENT_DOMAIN = "python"

/** Generous: initializing and one minimal computation only have to finish, on a slow connection too. */
const CHECK_TIMEOUT = "90 seconds"

/** How long a run waits for a check in progress; longer than the check may take. */
const SETTLE_TIMEOUT = "100 seconds"

/**
 * How long a run may go with no output and no request waiting for Earth Engine. A waiting request reports while it
 * waits, so only the script's own work counts, such as reading a large file.
 */
const IDLE_SECONDS = 120

/** Characters kept of what a run printed, the latest; the kernel cuts what it hands GeoAgent further. */
const OUTPUT_LIMIT = 1024 * 1024

/** Characters kept of output nobody parses, for the diagnostics. */
const OUTPUT_TAIL = 16 * 1024

/** Characters held while waiting for the end of a line; longer output without one is passed on as it is. */
const LINE_LIMIT = 64 * 1024

/**
 * The name gee.download gives a download's unfinished file. Only such a file is removed: the event is a line of output,
 * which anything the script prints could also make.
 */
const PARTIAL = /^\..+\.\d+\.part$/

const STILL_CHECKING = "Google Earth Engine is still being checked. Call geerun again in a minute."

/** Lines of an error GeoAgent is given. */
const PRINTED_LINES = 20

/** The Google Cloud project's ID, the whole of the block. */
const Block = Schema.String

/** What the settings page writes. */
const ConfigureParams = Schema.Struct({ project: Schema.String })

/**
 * What GEE reads of the environment's state, as geoengine/src/python/index.ts publishes it once it is ready: the base
 * environment's interpreter, and Python's version for the answer.
 */
const EnvironmentReady = Schema.Struct({ status: Schema.Literal("ready"), base: Schema.String, version: Schema.String })

/**
 * How long a sign-in waits for the user in the browser. Long enough to find the account and read the consent page;
 * a sign-in given up on, with the page closed, ends then.
 */
const SIGN_IN_TIMEOUT = "10 minutes"

const SignInEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("denied"), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), error: Schema.String, traceback: Schema.String }),
  Schema.Struct({ type: Schema.Literal("signed-in") }),
])

const Report = Schema.Struct({
  failed: Schema.optionalKey(Schema.Literals(["signed-out", "credentials", "unreachable", "rejected", "earthengine"])),
  error: Schema.optionalKey(Schema.String),
  traceback: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
  reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  said: Schema.optionalKey(Schema.String),
})

/**
 * The task a run works in: whether GeoAgent starts it, which a name already taken refuses; and whether this
 * conversation started it before, without which a task to continue must have a folder in GeoCode's.
 */
const Task = Schema.Struct({ name: Schema.String, new: Schema.Boolean, started: Schema.Boolean })

/** Inline or from a file, never both; `cwd` is the session's directory. */
const RunParams = Schema.Union([
  Schema.Struct({ script: Schema.String, cwd: Schema.String, task: Task }),
  Schema.Struct({ file: Schema.String, cwd: Schema.String, task: Task }),
])

const CheckParams = Schema.Struct({ cwd: Schema.String, file: Schema.optionalKey(Schema.String) })

const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("begin") }),
  Schema.Struct({ type: Schema.Literal("waiting"), seconds: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("initialize-failed"), error: Schema.String }),
  /** What the task holds, for the kernel to describe at the start of the answer. */
  Schema.Struct({ type: Schema.Literal("space"), space: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("space-failed"), error: Schema.String }),
  /** A few of the taken task's assets, and how many more it has. */
  Schema.Struct({ type: Schema.Literal("task-taken"), assets: Schema.Array(Schema.String), more: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("task-missing"), latest: Schema.Array(Schema.String) }),
  /**
   * What one of GeoCode's functions is doing, numbered so the tool row can tell one it missed; its share done from 0
   * to 1 when known, and no text once no function is doing anything.
   */
  Schema.Struct({
    type: Schema.Literal("status"),
    seq: Schema.Number,
    text: Schema.NullOr(Schema.String),
    progress: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("end"), ok: Schema.Boolean }),
  /** A download's unfinished file, which only the download's end moves into place. */
  Schema.Struct({ type: Schema.Literal("partial"), path: Schema.String }),
])

const decodeEnvironmentReady = Schema.decodeUnknownExit(EnvironmentReady)
const decodeReport = Schema.decodeUnknownExit(Report)
const decodeRunParams = Schema.decodeUnknownExit(RunParams)
const decodeCheckParams = Schema.decodeUnknownExit(CheckParams)
const decodeEvent = Schema.decodeUnknownExit(Event)
const decodeConfigureParams = Schema.decodeUnknownExit(ConfigureParams)
const decodeSignInEvent = Schema.decodeUnknownExit(SignInEvent)

export type Failed =
  | "config-error"
  | "signed-out"
  | "project-missing"
  | "unreachable"
  | "rejected"
  | "check-timeout"
  | "check-failed"

/** Why Google refused, by the credentials or by what its answer gives as the reason. */
export type Refusal = "credentials-invalid" | "project-not-found" | "no-permission" | "api-disabled" | "other"

/** The facts for locating a problem. */
export interface Diagnostics {
  readonly message: string
  /** machine.json, when it is the file at fault. */
  readonly file?: string
  readonly project?: string
  readonly refusal?: Refusal
  /** What Google answered, in its own words, when it answered. */
  readonly said?: string
  /** The HTTP status of an answer from an Earth Engine failing or overloaded. */
  readonly status?: number
  /** What the Python printed, when the check ended without a report or did not finish. */
  readonly output?: string
  /** Where the failure the check reported arose. */
  readonly traceback?: string
}

export type State =
  /** Also until GeoCode's Python environment is ready; the project, when there is one, so the settings show it. */
  | { readonly status: "checking"; readonly project?: string }
  | { readonly status: "ready"; readonly project: string }
  | { readonly status: Failed; readonly diagnostics: Diagnostics }

type Ready = Extract<State, { readonly status: "ready" }>

/**
 * What looking at Earth Engine found, which can change with nothing in machine.json changing, as when the user signs in
 * or the network comes back; each tool call checks again.
 */
const RECHECKED: ReadonlySet<State["status"]> = new Set([
  "signed-out",
  "unreachable",
  "rejected",
  "check-timeout",
  "check-failed",
])

const failed = (status: Failed, diagnostics: Diagnostics): State => ({ status, diagnostics })

export const capability: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  const config = yield* Config.Service
  const runtime = yield* Runtime.Service
  const block = yield* config.block(DOMAIN, Block)
  const writer = yield* status.register<State>(DOMAIN, { status: "checking" })
  const environment = yield* Deferred.make<typeof EnvironmentReady.Type>()

  /** Undefined when the check was stopped, as at shutdown, which says nothing about the environment. */
  const inspect = (python: string, project: string | undefined) =>
    runtime
      .run({
        ...Bundled.python(python, ["-"]),
        input: Python.program(Python.CHECK, { project: project ?? null }),
        delivery: { mode: "collect" },
        clocks: { total: CHECK_TIMEOUT },
      })
      .pipe(
        Effect.map((result) => judge(project, result)),
        // An interpreter that cannot be started fails here, before it has a pid or, on Windows, just after.
        Effect.catch((error) => Effect.succeed(failed("check-failed", { project, message: error.message }))),
      )

  const check = (python: string, state: Config.BlockState<typeof Block.Type>) =>
    Effect.gen(function* () {
      const token = yield* writer.claim()
      if (!state.ok) {
        yield* writer.commit(
          token,
          failed("config-error", { message: state.failure.message, file: state.failure.file }),
        )
        return
      }
      const project = state.value
      const where = project === undefined ? {} : { project }
      yield* writer.commit(token, { status: "checking", ...where })
      // An unexpected error would otherwise end the watch for good, leaving the domain checking forever.
      const next = yield* inspect(python, project).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(failed("check-failed", { ...where, message: Cause.pretty(cause) })),
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
  // Nothing is checked before the environment is ready: its base, which GEE runs in, is only then installed and warmed
  // up. A new configuration or recheck interrupts the check still running, ending its Python.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const found = yield* status.watch(ENVIRONMENT_DOMAIN).pipe(
        Stream.map((value) => decodeEnvironmentReady(value)),
        Stream.filter(Exit.isSuccess),
        Stream.runHead,
      )
      if (Option.isNone(found)) return
      const ready = found.value.value
      yield* Deferred.succeed(environment, ready)
      yield* Stream.runDrain(Stream.switchMap(triggers, (state) => Stream.fromEffect(check(ready.base, state))))
    }),
  )

  // The state a recheck was last asked from. Calls that find the same one ask once: a second ask would restart the
  // check, killing a Python that may have begun while the file was read again.
  let rechecked: State | undefined

  /**
   * The ready environment, once a check in progress settles; otherwise the state and what GeoAgent should do about it.
   * A state found by looking at the environment is checked again first; calls arriving once it has begun find it
   * checking and wait for it. Without a project, or a file to read it from, the file is read again instead, since
   * GeoAgent is told it takes effect as soon as it is saved.
   */
  const ready = (signal: AbortSignal) =>
    Effect.gen(function* () {
      const found = (yield* status.current(DOMAIN)) as State
      let stale = RECHECKED.has(found.status) ? found : undefined
      if (stale && rechecked !== stale) {
        rechecked = stale
        yield* PubSub.publish(rechecks, undefined)
      } else if (found.status === "config-error" || found.status === "project-missing") {
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
          message: current ? hint(current, config.file) : STILL_CHECKING,
          details: current,
        })
      }
      return current
    })

  const recheck: Engine.Method = () => PubSub.publish(rechecks, undefined).pipe(Effect.as({}))

  /**
   * Writes the project named in the settings; the watch then checks again. Over a block written wrong too: saving the
   * project fixes it.
   */
  const configure: Engine.Method = (raw) =>
    Effect.gen(function* () {
      const decoded = decodeConfigureParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const project = decoded.value.project
      // In ASCII, as a request header carries it; with a domain and a colon before it for some older projects. Anything
      // else is left to Earth Engine to accept or refuse.
      if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(project)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `"${project}" is not a project ID` })
      }
      yield* block
        .write(project)
        .pipe(Effect.mapError((error) => new Engine.Failure({ code: "write-failed", message: error.message })))
      return {}
    })

  // One sign-in at a time: one started from another window ends the one before, whose browser page is then stale.
  let signing: AbortController | undefined

  /**
   * Signs the user in with the base environment's Python, reporting the address the browser is to open; the check that
   * follows finds the credentials. Ends when the user finishes or denies access in the browser, or after
   * SIGN_IN_TIMEOUT. machine.json has no part in it.
   */
  const signIn: Engine.Method = (_raw, context) =>
    Effect.gen(function* () {
      // The main window opens once it is ready; a request before then is refused rather than left waiting.
      if (!(yield* Deferred.isDone(environment))) {
        return yield* new Engine.Failure({
          code: "not-ready",
          message: "GeoCode's Python environment is not ready yet",
        })
      }
      const python = (yield* Deferred.await(environment)).base
      signing?.abort()
      const mine = new AbortController()
      signing = mine
      let outcome: Exclude<typeof SignInEvent.Type, { readonly type: "url" }> | undefined
      let printed = ""
      let pending = ""
      const onChunk = (chunk: string, stream: "stdout" | "stderr") => {
        if (stream === "stderr") {
          printed = tail(printed + chunk)
          return
        }
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ""
        for (const line of lines) {
          const payload = Python.markedLine(line)
          const decoded = payload === undefined ? undefined : decodeSignInEvent(payload)
          if (!decoded || Exit.isFailure(decoded)) printed = tail(`${printed}${line}\n`)
          else if (decoded.value.type === "url") context.progress({ url: decoded.value.url })
          else outcome = decoded.value
        }
        if (pending.length <= LINE_LIMIT) return
        printed = tail(printed + pending)
        pending = ""
      }
      const result = yield* runtime
        .run({
          ...Bundled.python(python, ["-"]),
          input: Python.program(Python.SIGN_IN, {}),
          delivery: { mode: "incremental", source: "all", onChunk },
          clocks: { total: SIGN_IN_TIMEOUT },
          signal: AbortSignal.any([context.signal, mine.signal]),
        })
        .pipe(
          Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
          Effect.ensuring(
            Effect.sync(() => {
              if (signing === mine) signing = undefined
            }),
          ),
        )
      if (outcome?.type === "signed-in") {
        yield* PubSub.publish(rechecks, undefined)
        return {}
      }
      if (result.reason === "abort") {
        const replaced = mine.signal.aborted && !context.signal.aborted
        return yield* new Engine.Failure(
          replaced
            ? { code: "replaced", message: "another sign-in was started" }
            : { code: "cancelled", message: "the sign-in was cancelled" },
        )
      }
      if (result.reason === "timeout") {
        return yield* new Engine.Failure({
          code: "timeout",
          message: `the sign-in was not finished in the browser within ${SIGN_IN_TIMEOUT}`,
        })
      }
      if (outcome?.type === "denied") {
        return yield* new Engine.Failure({ code: "denied", message: `Google did not grant access: ${outcome.error}` })
      }
      if (outcome?.type === "failed") {
        return yield* new Engine.Failure({
          code: "sign-in-failed",
          message: outcome.error,
          details: { traceback: outcome.traceback },
        })
      }
      const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
      return yield* new Engine.Failure({
        code: "sign-in-failed",
        message: `the Python exited with ${ending} before the sign-in finished`,
        details: { output: printed },
      })
    })

  /** The ready environment, once the folders and file a run names are found to be there. */
  const admit = (params: { readonly cwd: string; readonly file?: string }, signal: AbortSignal) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(params.cwd) || !(yield* Effect.promise(() => isKind(params.cwd, "directory")))) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${params.cwd} is not a directory` })
      }
      const file = params.file
      if (file !== undefined && (!path.isAbsolute(file) || !(yield* Effect.promise(() => isKind(file, "file"))))) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${file} is not a file` })
      }
      return yield* ready(signal)
    })

  /** Whether a run could start now, asked before the user is asked about it; runs nothing. */
  const precheck: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeCheckParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      yield* admit(decoded.value, context.signal)
      return {}
    })

  /** The tasks being run, by project and name: two runs of one task, from any conversation, would race to save. */
  const running = new Set<string>()

  /** Runs GeoAgent's script in the base environment, ending it after IDLE_SECONDS with neither output nor a wait. */
  const run: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeRunParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const params = decoded.value
      if (!Library.NAME.test(params.task.name)) {
        return yield* new Engine.Failure({
          code: "invalid-params",
          message: `"${params.task.name}" is not a task name: ${Library.NAME_RULE}`,
        })
      }
      const current = yield* admit(
        { cwd: params.cwd, ...("file" in params ? { file: params.file } : {}) },
        context.signal,
      )
      // Ready only once the environment was. Awaited before the task is looked up: nothing may yield between finding it
      // free and taking it.
      const python = yield* Deferred.await(environment)
      const key = `${current.project}/${params.task.name}`
      if (running.has(key)) {
        return yield* new Engine.Failure({
          code: "task-busy",
          message: `The task ${params.task.name} is already running in another call`,
        })
      }
      running.add(key)
      return yield* execute(runtime, python, current, params, context).pipe(
        // The environment changed since it was found ready, as when the credentials were revoked: it is checked again,
        // so this call says what is wrong and the indicator stops showing it ready.
        Effect.catchIf(
          (failure) => failure.code === "initialize-failed" || failure.code === "start-failed",
          (failure) =>
            Effect.gen(function* () {
              // Whatever is there now is passed over, so the answer is this recheck's, not a state settled before it.
              const before = (yield* status.current(DOMAIN)) as State
              yield* PubSub.publish(rechecks, undefined)
              const next = yield* Effect.raceFirst(settledState(status, before), cancelled(context.signal))
              if (next === undefined || next.status === "ready") return yield* failure
              return yield* new Engine.Failure({ code: "not-ready", message: hint(next, config.file), details: next })
            }),
        ),
        Effect.ensuring(Effect.sync(() => running.delete(key))),
      )
    })

  /** The configured project's monthly quota, for the user (Quota.query), once GEE is ready. */
  const quota: Engine.Method = (_raw, context) =>
    Effect.gen(function* () {
      const current = yield* ready(context.signal)
      const python = yield* Deferred.await(environment)
      return yield* Quota.query(runtime, python.base, current.project, context.signal)
    })

  return { domain: DOMAIN, methods: { check: precheck, run, recheck, configure, signIn, quota } }
})

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

function judge(project: string | undefined, result: Runtime.Result): State | undefined {
  if (result.reason === "abort") return
  const where = project === undefined ? {} : { project }
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
  const error = report.error ?? ""
  const traceback = report.traceback
  if (report.failed === "signed-out") {
    return failed("signed-out", { ...where, message: "no Earth Engine credentials on this computer" })
  }
  const said = report.said === undefined ? {} : { said: report.said }
  if (report.failed === "credentials") {
    return failed("rejected", { ...where, message: error, refusal: "credentials-invalid", ...said, traceback })
  }
  const status = report.status ?? 0
  if (report.failed === "unreachable") return failed("unreachable", { ...where, message: error, traceback })
  // Earth Engine failing or overloaded refuses nothing: it is unreachable for now.
  if (report.failed === "rejected" && (status >= 500 || status === 429)) {
    return failed("unreachable", { ...where, message: error, ...said, status, traceback })
  }
  if (report.failed === "rejected") {
    const refusal = refusalOf(report.status, report.reasons ?? [])
    return failed("rejected", { ...where, message: error, refusal, ...said, traceback })
  }
  if (report.failed === "earthengine") return failed("check-failed", { ...where, message: error, traceback })
  if (project === undefined) {
    return failed("project-missing", { ...where, message: "no Google Cloud project is configured" })
  }
  return { status: "ready", project }
}

/**
 * Why Earth Engine refused, by the HTTP status and the reasons its answer gives, never by its wording. A project that
 * does not exist and one the account may not use share their reason and differ in status; a project not registered for
 * Earth Engine has no reason of its own.
 */
function refusalOf(status: number | undefined, reasons: readonly string[]): Refusal {
  if (reasons.includes("SERVICE_DISABLED")) return "api-disabled"
  // Credentials without Earth Engine's scope need signing in again too.
  if (status === 401 || reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "credentials-invalid"
  if (reasons.includes("USER_PROJECT_DENIED")) return status === 400 ? "project-not-found" : "no-permission"
  return "other"
}

/**
 * What GeoAgent is told when Google Earth Engine is not ready: the facts, and, where there is a sure remedy, what it can
 * do itself and what only the user can.
 */
export function hint(state: Exclude<State, Ready>, file: string): string {
  if (state.status === "checking") return STILL_CHECKING
  if (state.status === "config-error") {
    const at = state.diagnostics.file ?? file
    return `${at} cannot be read: ${state.diagnostics.message}. No geo tool works until it is fixed; it is checked as soon as the file is saved.`
  }
  const configured = `The configuration is the "gee" entry of ${file}, the Google Cloud project ID: "gee": "<project ID>". It is checked as soon as the file is saved; then call geerun again.`
  const again = "It is checked again the next time geerun is called."
  const projectId =
    "Ask the user for the ID of their Google Cloud project registered for Earth Engine, which the Code Editor (https://code.earthengine.google.com) shows at its top; never guess it."
  const diagnostics = state.diagnostics
  const last = (text: string) => text.trim().split("\n").slice(-PRINTED_LINES).join("\n")
  const said = diagnostics.said === undefined ? [] : [`Google said: ${last(diagnostics.said)}`]
  const signIn = (retry: boolean) =>
    `Ask the user to sign in${retry ? " again" : ""} with their Google account in GeoCode's settings, under Geo environment, Google Earth Engine.`
  if (state.status === "signed-out") {
    return [
      "Google Earth Engine is not signed in: there are no Earth Engine credentials on this computer.",
      signIn(false),
      again,
    ].join("\n")
  }
  if (state.status === "project-missing") {
    return ["Google Earth Engine is signed in, but no Google Cloud project is configured.", projectId, configured].join(
      "\n",
    )
  }
  const project = diagnostics.project ?? ""
  // Only the fact: what the network needs is for GeoAgent and the user to work out.
  if (state.status === "unreachable" || state.status === "check-timeout") {
    return diagnostics.status === undefined
      ? "Cannot connect to Google: there is no network connection, or Google cannot be reached."
      : `Google Earth Engine is failing or busy right now (HTTP ${diagnostics.status}).`
  }
  if (state.status === "rejected") {
    const refusal = diagnostics.refusal ?? "other"
    if (refusal === "credentials-invalid") {
      return [
        "Google refused the Earth Engine credentials on this computer: they have expired or been revoked.",
        ...said,
        signIn(true),
        again,
      ].join("\n")
    }
    const opening = {
      "project-not-found": `There is no Google Cloud project with the configured ID, ${project}.`,
      "no-permission": `The signed-in Google account may not use the configured project, ${project}.`,
      "api-disabled": `The Earth Engine API is not enabled in the configured project, ${project}.`,
      other: `Earth Engine refused the configured project, ${project}.`,
    }[refusal]
    const remedy = {
      "project-not-found":
        "Ask the user for the right ID, which the Code Editor (https://code.earthengine.google.com) shows at its top; never guess it.",
      "no-permission":
        "Ask the user whether the ID is right and whether the project belongs to the account they signed in with; they may need to sign in with another account, or use a project of their own.",
      "api-disabled": `Ask the user to enable it at https://console.cloud.google.com/apis/library/earthengine.googleapis.com?project=${project}; it takes a few minutes to apply.`,
      other:
        "If the project is not registered for Earth Engine, the user can register it at https://code.earthengine.google.com/register. Otherwise, act on what Google said.",
    }[refusal]
    // An ID the user corrects is checked as soon as the file is saved; whatever else they fix, on the next call.
    return [opening, ...said, remedy, configured, again].join("\n")
  }
  // Without a report, GeoEngine's own message says only that there was none; what the Python printed says why.
  const printed = diagnostics.output ? [last(diagnostics.output)] : []
  return [
    `Checking Google Earth Engine failed: ${last(diagnostics.message)}`,
    ...printed,
    "Show the user the error.",
    again,
  ].join("\n")
}

function execute(
  runtime: Runtime.Interface,
  python: typeof EnvironmentReady.Type,
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
  let space: unknown
  let spaceError: string | undefined
  let taken: { readonly assets: readonly string[]; readonly more: number } | undefined
  let missing: readonly string[] | undefined
  const partials = new Set<string>()
  const pending = { stdout: "", stderr: "" }
  // What the script printed since the tool row was last sent some.
  let unsent = ""

  // For the tool row's log, the answer getting it at the end: what a chunk brought, in one message rather than one a
  // line, and before any event, so the log and the statuses keep their order.
  const send = () => {
    if (!unsent) return
    context.progress({ output: unsent })
    unsent = ""
  }

  const keep = (text: string, stream: "stdout" | "stderr") => {
    if (!begun[stream]) {
      noise = tail(noise + text)
      return
    }
    output += text
    unsent += text
    // Cut back with room to spare, not on every line past the limit, which would copy the whole output each time.
    if (output.length <= 2 * OUTPUT_LIMIT) return
    output = output.slice(-OUTPUT_LIMIT)
    truncated = true
  }

  const line = (text: string, stream: "stdout" | "stderr", newline: boolean) => {
    const payload = Python.markedLine(text)
    const decoded = payload === undefined ? undefined : decodeEvent(payload)
    if (!decoded || Exit.isFailure(decoded)) return keep(newline ? `${text}\n` : text, stream)
    send()
    const event = decoded.value
    if (event.type === "waiting") return context.progress({ waiting: event.seconds })
    if (event.type === "initialize-failed") {
      initializeError = event.error
      return
    }
    if (event.type === "space") {
      space = event.space
      return
    }
    if (event.type === "space-failed") {
      spaceError = event.error
      return
    }
    if (event.type === "task-taken") {
      taken = { assets: event.assets, more: event.more }
      return
    }
    if (event.type === "task-missing") {
      missing = event.latest
      return
    }
    if (event.type === "status") {
      const status = { seq: event.seq, text: event.text }
      return context.progress({
        status: event.progress === undefined ? status : { ...status, progress: event.progress },
      })
    }
    if (event.type === "end") {
      ended = { ok: event.ok }
      return
    }
    if (event.type === "partial") {
      if (PARTIAL.test(path.basename(event.path))) partials.add(event.path)
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
    if (pending[stream].length > LINE_LIMIT) {
      keep(pending[stream], stream)
      pending[stream] = ""
    }
    send()
  }

  const request = {
    project: current.project,
    task: params.task,
    folder: Library.FOLDER,
    ...("file" in params ? { file: params.file } : { script: params.script }),
  }

  return runtime
    .run({
      ...Bundled.python(python.base, ["-"]),
      input: Python.program(Python.RUN, request),
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
          send()
          // The process has ended, or was killed and waited for, so a download it left unfinished can go; one still
          // held, as by a virus scanner on Windows, stays.
          yield* Effect.promise(() =>
            Promise.all([...partials].map((file) => fsp.rm(file, { force: true }).catch(() => undefined))),
          )
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
          if (spaceError !== undefined) {
            return yield* new Engine.Failure({ code: "space-failed", message: spaceError, details: { noise } })
          }
          if (taken !== undefined) {
            const count = taken.assets.length + taken.more
            const rest = taken.more ? ` and ${taken.more} more` : ""
            const held = count ? `, with ${plural(count, "asset")}: ${taken.assets.join(", ")}${rest}` : ""
            return yield* new Engine.Failure({
              code: "task-taken",
              message: `The task ${params.task.name} already exists${held}`,
              details: taken,
            })
          }
          if (missing !== undefined) {
            const latest = missing.length ? `; the latest tasks are ${missing.join(", ")}` : "; there are no tasks yet"
            return yield* new Engine.Failure({
              code: "task-missing",
              message: `There is no task ${params.task.name}: it has saved nothing in GeoCode's folder, and this conversation did not start it${latest}`,
              details: { latest: missing },
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
            // Its version alone: given the interpreter's path, GeoAgent could take the base environment for its work.
            python: { version: python.version },
            ...(space === undefined ? {} : { space }),
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

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function tail(text: string) {
  return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL)
}
