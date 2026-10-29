export * as Qgis from "./index.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Duration, Effect, Exit, Option, PubSub, Schema, Semaphore, Stream } from "effect"
import { Config } from "../config.ts"
import { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"
import { Catalog } from "./catalog.ts"
import { Doc } from "./doc.ts"
import { Geodata } from "./geodata.ts"
import { Installs } from "./installs.ts"
import { Macos } from "./macos.ts"
import { Plan } from "./plan.ts"
import { Python } from "./python.ts"
import { Reader } from "./reader.ts"
import { Windows } from "./windows.ts"

const DOMAIN = "qgis"

/** How this system's QGIS is found, started and described to GeoAgent; none where GeoCode cannot run QGIS. */
const PLATFORM = process.platform === "darwin" ? Macos : process.platform === "win32" ? Windows : undefined

/** What GeoAgent is told of finding and configuring QGIS, which differs between the systems. */
export interface Guide {
  readonly FINDING: string
  readonly CONFIGURED: string
  readonly NO_PYTHON: string
}

/** Generous: the probe only has to finish, and a first start from a cold disk is slow. */
const PROBE_TIMEOUT = "2 minutes"

/** How long a run waits for a check in progress; longer than the probe may take. */
const SETTLE_TIMEOUT = "150 seconds"

const SPOTLIGHT_TIMEOUT = "10 seconds"

/** Listing the fixed drives starts PowerShell, which takes a second or two. */
const DRIVES_TIMEOUT = "10 seconds"

/** Listing takes seconds; as long as a probe, for a cold disk. */
const CATALOG_TIMEOUT = PROBE_TIMEOUT

/** Asking QGIS about coordinate reference systems takes the second or two it needs to start. */
const CRS_TIMEOUT = PROBE_TIMEOUT

/** Characters kept of output nobody parses, for the diagnostics. */
const OUTPUT_TAIL = 16 * 1024

/** Characters held while waiting for the end of a line; longer output without one is noise. */
const LINE_LIMIT = 1024 * 1024

/** A read reports every two seconds while it works; this long without a word means it is stuck. */
const READ_IDLE = "5 minutes"

/** How long a checked run's output names stay taken if it never runs, as when the user refuses it. */
const RESERVATION_MS = 60 * 60 * 1000

/** Marks the line QGIS adds with the outputs, which the end of the answer lists. */
const RESULTS = /^Results: \{/

/** A preview of a large multiband raster runs to several megabytes of base64. */
const READ_OUTPUT_LIMIT = 64 * 1024 * 1024

/** As many sample features as a read returns at most. */
const SAMPLE_LIMIT = 50

const Block = Schema.Struct({ path: Schema.String })

// The failure first: a processing failure carries every field a success does.
const Report = Schema.Union([
  Schema.Struct({
    python: Schema.String,
    failed: Schema.Literals(["gdal", "proj", "core", "processing"]),
    error: Schema.String,
    environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({ python: Schema.String, gdal: Schema.String, qgis: Schema.String, algorithms: Schema.Number }),
])

const LocateParams = Schema.Struct({
  algorithm: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
})

/** The files `locate` found, resolved by the caller, in the same order; `cwd` as the run will have it. */
const PrepareParams = Schema.Struct({
  ...LocateParams.fields,
  files: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
})

const RunParams = Schema.Struct({ ...LocateParams.fields, cwd: Schema.optionalKey(Schema.String) })

const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("begin") }),
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

const CrsReport = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), read: Schema.Array(Schema.Boolean) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])

const DocParams = Schema.Struct({
  action: Schema.Literals(["groups", "algorithms", "help", "search"]),
  group: Schema.optionalKey(Schema.String),
  algorithm: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
})

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const ReadParams = Schema.Struct({
  path: Schema.String,
  layer: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Count),
  limit: Schema.optionalKey(Count.check(Schema.isLessThanOrEqualTo(SAMPLE_LIMIT))),
  encoding: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.Boolean),
  bands: Schema.optionalKey(Schema.Array(Count)),
})

const decodeBlock = Schema.decodeUnknownExit(Block)
const decodeReport = Schema.decodeUnknownExit(Report)
const decodeLocateParams = Schema.decodeUnknownExit(LocateParams)
const decodePrepareParams = Schema.decodeUnknownExit(PrepareParams)
const decodeRunParams = Schema.decodeUnknownExit(RunParams)
const decodeInspection = Schema.decodeUnknownExit(Reader.Inspection)
const decodeEvent = Schema.decodeUnknownExit(Event)
const decodeCrsReport = Schema.decodeUnknownExit(CrsReport)
const decodeDocParams = Schema.decodeUnknownExit(DocParams)
const decodeCatalog = Schema.decodeUnknownExit(Catalog.Report)
const decodeReadParams = Schema.decodeUnknownExit(ReadParams)
const decodeReading = Schema.decodeUnknownExit(Reader.Report)

export type Failed =
  | "config-error"
  | "platform-unsupported"
  | "path-missing"
  | "not-qgis"
  | "ambiguous"
  | "python-missing"
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
  /** The folder the configured path is in, when it holds more than one QGIS, and those of them that can start. */
  readonly folder?: string
  readonly choices?: readonly Installs.Found[]
  /**
   * Where QGIS's launcher pointed Python, QGIS and Qt, when a step of the check failed. For the user's diagnostics
   * only: GeoAgent's message goes to the model's provider, and the user's PATH names their folders.
   */
  readonly environment?: Readonly<Record<string, string>>
}

export type State =
  | { readonly status: "unconfigured" }
  | { readonly status: "checking"; readonly path: string }
  | {
      readonly status: "ready"
      readonly app: string
      readonly interpreter: string
      readonly version: string | undefined
      readonly versions: { readonly qgis: string; readonly gdal: string; readonly python: string }
      readonly algorithms: number
    }
  | { readonly status: Failed; readonly diagnostics: Diagnostics }

type Ready = Extract<State, { readonly status: "ready" }>

/**
 * What looking at QGIS found, which can change with nothing in machine.json changing, as when QGIS is reinstalled
 * where it was; each tool call checks again.
 */
const RECHECKED: ReadonlySet<State["status"]> = new Set([
  "path-missing",
  "not-qgis",
  "ambiguous",
  "python-missing",
  "gdal-missing",
  "proj-broken",
  "core-missing",
  "processing-failed",
  "probe-timeout",
  "probe-failed",
])

const SYMPTOMS = {
  "gdal-missing": "its Python cannot load GDAL",
  "proj-broken": "it cannot transform coordinates, so its projection data is missing or broken",
  "core-missing": "its Python cannot load QGIS itself",
  "processing-failed": "its Processing framework does not start, so no algorithm can run",
  "probe-failed": "it failed while being checked",
} as const

/** Lines of the check's output GeoAgent is given when QGIS does not work. */
const PRINTED_LINES = 20

const failed = (status: Failed, diagnostics: Diagnostics): State => ({ status, diagnostics })

export const capability: Engine.Capability = Effect.gen(function* () {
  const status = yield* Status.Service
  const config = yield* Config.Service
  const runtime = yield* Runtime.Service
  const block = yield* config.block(DOMAIN, Block)
  const writer = yield* status.register<State>(DOMAIN, settledOrChecking(yield* block.current))

  const probe = (configured: string, install: Installs.Install) =>
    runtime
      .run({
        ...python(install, Python.PROBE),
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
      if (!PLATFORM) {
        return failed("platform-unsupported", { message: `no QGIS support for ${process.platform}`, path: configured })
      }
      const located = yield* Effect.promise<Macos.Located | Windows.Located>(() => PLATFORM.locate(configured))
      if (!located.ok) {
        return failed(located.status, {
          message: located.message,
          path: configured,
          app: located.app,
          version: located.version,
          ...("choices" in located && { folder: located.folder, choices: located.choices }),
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
  // The file is read again first: its watch may have died, and then the configuration in memory is stale.
  const triggers = Stream.merge(
    block.watch,
    Stream.fromSubscription(asked).pipe(Stream.mapEffect(() => config.reload().pipe(Effect.andThen(block.current)))),
  )
  // A new configuration or recheck interrupts the check still running, ending its probe.
  yield* Effect.forkScoped(Stream.runDrain(Stream.switchMap(triggers, (state) => Stream.fromEffect(check(state)))))

  const discover: Engine.Method = (_raw, context) =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        // Without the list, the system drive alone is looked at.
        const drives = yield* runtime
          .run({
            ...Windows.drivesCommand(),
            delivery: { mode: "collect" },
            clocks: { total: DRIVES_TIMEOUT },
            signal: context.signal,
          })
          .pipe(
            Effect.map((result) =>
              result.reason === "exit" && result.code === 0 ? Windows.drives(result.stdout) : [],
            ),
            Effect.catch(() => Effect.succeed([])),
          )
        return { installs: yield* Effect.promise(() => Windows.installs(drives)) }
      }
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

  // The state a recheck was last asked from. Calls that find the same one ask once: a second ask would restart the
  // check, killing a probe that may have begun while the file was read again.
  let rechecked: State | undefined

  /**
   * The ready QGIS, once a check in progress settles; otherwise the state and what GeoAgent should do about it. A
   * state found by looking at QGIS is checked again first; calls arriving once it has begun find it checking and wait
   * for it. Without a QGIS to look at, the file is read again instead, since GeoAgent is told it takes effect as soon
   * as it is saved: a call can come within the watch's debounce, or after the watch died.
   */
  const ready = (signal: AbortSignal) =>
    Effect.gen(function* () {
      const found = (yield* status.current(DOMAIN)) as State
      let stale = RECHECKED.has(found.status) ? found : undefined
      if (stale && rechecked !== stale) {
        rechecked = stale
        yield* PubSub.publish(rechecks, undefined)
      } else if (found.status === "unconfigured" || found.status === "config-error") {
        yield* config.reload()
        if (settledOrChecking(yield* block.current).status !== found.status) stale = found
      }
      const current = yield* Effect.raceFirst(settledState(status, stale), cancelled(signal))
      if (current?.status !== "ready") {
        return yield* new Engine.Failure({
          code: "not-ready",
          message: current ? hint(current, config.file) : "QGIS is still being checked.",
          details: current,
        })
      }
      return current
    })

  // One listing per QGIS, shared by the requests that arrive while it is made; a failed one is made again next time.
  const scope = yield* Effect.scope
  let listing:
    | { readonly key: string; readonly catalog: Deferred.Deferred<Catalog.Catalog, Engine.Failure> }
    | undefined

  const catalogFor = (install: Ready) =>
    Effect.gen(function* () {
      const key = `${install.interpreter}\n${install.versions.qgis}`
      const current =
        listing?.key === key ? listing : { key, catalog: yield* Deferred.make<Catalog.Catalog, Engine.Failure>() }
      if (current !== listing) {
        listing = current
        // Forked, so a caller that gives up does not stop the listing the others wait for.
        yield* list(runtime, install).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && listing === current) listing = undefined
            }),
          ),
          Effect.flatMap((exit) => Deferred.done(current.catalog, exit)),
          Effect.forkIn(scope),
        )
      }
      return current.catalog
    }).pipe(
      // A listing recorded is a listing started, or every later request would wait on it.
      Effect.uninterruptible,
      Effect.flatMap(Deferred.await),
    )

  const doc: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeDocParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const current = yield* ready(context.signal)
      const catalog = yield* Effect.raceFirst(catalogFor(current), cancelled(context.signal))
      return { text: Doc.answer(catalog, decoded.value) }
    })

  /**
   * The output names checked runs have taken, with when they lapse, so two runs never take one name. Taken one at a
   * time: choosing a name and taking it are separated by reading folders.
   */
  const reservations = new Map<string, number>()
  const numbering = yield* Semaphore.make(1)

  const reserved = () => {
    const now = Date.now()
    for (const [key, lapses] of reservations) if (lapses <= now) reservations.delete(key)
    return new Set(reservations.keys())
  }

  // The first of the three steps of a run, then the second; the kernel resolves the files in between and asks the user
  // after. Neither runs anything of the algorithm's.
  const locate: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeLocateParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const current = yield* ready(context.signal)
      const catalog = yield* Effect.raceFirst(catalogFor(current), cancelled(context.signal))
      const located = Plan.locate(catalog, decoded.value)
      if (located.kind === "refused") return { refused: located.text }
      return { files: located.slots.map((slot) => slot.file) }
    })

  const prepare: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodePrepareParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const request = decoded.value
      const relative = request.files.find((file) => !path.isAbsolute(file))
      if (relative !== undefined) {
        return yield* new Engine.Failure({ code: "invalid-params", message: `${relative} is not an absolute path` })
      }
      const current = yield* ready(context.signal)
      const catalog = yield* Effect.raceFirst(catalogFor(current), cancelled(context.signal))
      const located = Plan.locate(catalog, request)
      if (located.kind === "refused") return { refused: located.text }
      if (located.slots.length !== request.files.length) {
        const message = `the parameters name ${located.slots.length} files, not ${request.files.length}`
        return yield* new Engine.Failure({ code: "invalid-params", message })
      }
      const { slots } = Plan.substitute(request.parameters, located.slots, request.files)
      const survey = Plan.survey(slots)
      const systems = Plan.coordinateSystems(located.algorithm, request.parameters)
      const [inspection, read] = yield* Effect.all(
        [
          survey.layers.length || survey.tables.length
            ? inspectData(runtime, current, survey.request, context.signal)
            : Effect.succeed({ layers: [], tables: [] }),
          systems.length
            ? readCoordinateSystems(runtime, current, systems, request.cwd, context.signal)
            : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      )
      const reasons = [...Plan.unread(systems, read), ...Plan.mixed(survey.layers, inspection.layers)]
      if (reasons.length) return { refused: Plan.refusal(catalog, located.algorithm, reasons) }
      const tables = new Map(survey.tables.map((slot, index) => [slot.file, inspection.tables[index] ?? null]))
      const numbered = yield* numbering.withPermit(
        Effect.gen(function* () {
          const numbered = yield* Effect.promise(() => Plan.number(slots, tables, reserved()))
          for (const key of numbered.claimed) reservations.set(key, Date.now() + RESERVATION_MS)
          return numbered
        }),
      )
      return { plan: Plan.plan(catalog, located.algorithm, request, numbered) }
    })

  /** The last step: runs what `prepare` planned, as the user allowed it. */
  const run: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeRunParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      const params = decoded.value
      const current = yield* ready(context.signal)
      const catalog = yield* Effect.raceFirst(catalogFor(current), cancelled(context.signal))
      const located = Plan.locate(catalog, params)
      if (located.kind === "refused") {
        return yield* new Engine.Failure({ code: "invalid-params", message: located.text })
      }
      // The names it holds are kept while it runs, however long, and let go however it ends, refused here included.
      const claims = Plan.claims(located.slots)
      for (const key of claims) reservations.set(key, Number.POSITIVE_INFINITY)
      return yield* Effect.gen(function* () {
        // Checked here, or a missing one reads as a missing interpreter.
        const cwd = params.cwd
        if (cwd !== undefined && !(yield* Effect.promise(() => isDirectory(cwd)))) {
          return yield* new Engine.Failure({ code: "invalid-params", message: `${cwd} is not a directory` })
        }
        yield* Effect.promise(() => Plan.folders(located.slots))
        // What is there before it runs, which a run that does not finish leaves alone.
        const before = yield* Effect.promise(() => Plan.present(located.slots))
        return yield* execute(runtime, current, params, located.algorithm, located.slots, before, context)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const key of claims) reservations.delete(key)
          }),
        ),
      )
    })

  const read: Engine.Method = (raw, context) =>
    Effect.gen(function* () {
      const decoded = decodeReadParams(raw)
      if (Exit.isFailure(decoded)) {
        return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
      }
      if (!path.isAbsolute(decoded.value.path)) {
        return yield* new Engine.Failure({
          code: "invalid-params",
          message: `${decoded.value.path} is not an absolute path`,
        })
      }
      const current = yield* ready(context.signal)
      return yield* readData(runtime, current, decoded.value, context.signal)
    })

  return { domain: DOMAIN, methods: { locate, prepare, run, doc, read, discover, configure, recheck } }
})

/** The state a configuration settles on at once, or `checking` when it names a QGIS to probe. */
function settledOrChecking(state: Config.BlockState<typeof Block.Type>): State {
  if (!state.ok) return failed("config-error", { message: state.failure.message, file: state.failure.file })
  if (state.value === undefined) return { status: "unconfigured" }
  return { status: "checking", path: state.value.path }
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

/**
 * What GeoAgent is told when QGIS is not ready: the facts, and how to set QGIS up itself when it can. The settings page
 * is the user's way and is not mentioned.
 */
export function hint(state: Exclude<State, Ready>, file: string, guide: Guide | undefined = PLATFORM): string {
  if (state.status === "checking") return "QGIS is still being checked."
  if (state.status === "config-error") {
    const at = state.diagnostics.file ?? file
    return `${at} cannot be read: ${state.diagnostics.message}. No QGIS tool works until it is fixed; it is checked as soon as the file is saved.`
  }
  if (state.status === "platform-unsupported" || !guide) return "GeoCode cannot run QGIS on this operating system."
  const configured = `Its configuration is in ${file}, ${guide.CONFIGURED}`
  const write =
    "Write its path to the file; QGIS is checked as soon as the file is saved. Then call qgisdoc to see whether QGIS is ready."
  const forbidden =
    "Do not install QGIS yourself, wrap it in a script, or run its Python: GeoCode sets up and checks QGIS from the path alone."
  const setup = (opening: string) =>
    [
      opening,
      configured,
      `${guide.FINDING} If there is none, ask the user to install one from https://qgis.org/download/.`,
      write,
      forbidden,
    ].join("\n")
  if (state.status === "unconfigured") return setup("QGIS is not configured.")
  const { diagnostics } = state
  const app = diagnostics.app ?? diagnostics.path
  if (state.status === "path-missing") return setup(`The configured QGIS cannot be found: ${diagnostics.message}.`)
  if (state.status === "not-qgis") {
    return setup(`The configured path is not a QGIS installation: ${diagnostics.message}.`)
  }
  if (state.status === "ambiguous") {
    const choices = (diagnostics.choices ?? []).map((choice) =>
      choice.version ? `${choice.app} (${choice.version})` : choice.app,
    )
    return [
      `The configured folder, ${diagnostics.folder ?? diagnostics.path}, holds more than one QGIS: ${choices.join(", ")}. Ask the user which to use, and write its folder.`,
      configured,
      write,
      forbidden,
    ].join("\n")
  }
  if (state.status === "probe-timeout") {
    return [
      `Checking the configured QGIS, ${app}, took longer than ${PROBE_TIMEOUT}, so the computer may be busy; it is checked again the next time a QGIS tool is called.`,
      forbidden,
    ].join("\n")
  }
  const named = diagnostics.version ? `${app} (${diagnostics.version})` : app
  const last = (text: string) => text.split("\n").slice(-PRINTED_LINES).join("\n")
  const output = diagnostics.output?.trim()
  // Without output, a failed check has only GeoEngine's own message, which says what stopped it; the other failures'
  // messages repeat the symptom.
  const printed = output
    ? [
        diagnostics.interpreter ? `The check ran ${diagnostics.interpreter} and printed:` : "The check printed:",
        last(output),
      ]
    : state.status === "probe-failed"
      ? [`The check failed: ${last(diagnostics.message)}`]
      : []
  return [
    `The configured QGIS, ${named}, does not work: ${state.status === "python-missing" ? guide.NO_PYTHON : SYMPTOMS[state.status]}.`,
    ...printed,
    "Ask the user to reinstall QGIS from https://qgis.org/download/, or to use another QGIS on this computer; QGIS is checked again each time a QGIS tool is called. Do not try to repair QGIS.",
    configured,
    guide.FINDING,
    write,
    forbidden,
  ].join("\n")
}

function where(configured: string, install: Installs.Install) {
  return { path: configured, app: install.app, version: install.version, interpreter: install.interpreter }
}

function judge(configured: string, install: Installs.Install, result: Runtime.Result): State | undefined {
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
    const output = tail(report.error)
    return failed(status, { ...where(configured, install), message, output, environment: report.environment })
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

/** How a task starts QGIS's Python with a script, and the request it reads, if any. */
function python(install: Installs.Install, script: string, request?: unknown) {
  return {
    command: install.interpreter,
    args: ["-"],
    input: Python.program(script, request),
    env: PLATFORM?.environment(install),
  }
}

/** Lists the offered algorithms of a ready QGIS, from QGIS's own definitions. */
function list(runtime: Runtime.Interface, install: Ready) {
  return runtime
    .run({
      ...python(install, Python.CATALOG),
      delivery: { mode: "collect" },
      clocks: { total: CATALOG_TIMEOUT },
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "catalog-failed", message: error.message })),
      Effect.flatMap((result) => {
        const fail = (message: string) =>
          Effect.fail(new Engine.Failure({ code: "catalog-failed", message, details: { stderr: tail(result.stderr) } }))
        if (result.reason === "timeout") return fail(`listing the algorithms did not finish within ${CATALOG_TIMEOUT}`)
        if (result.reason !== "exit") return fail("listing the algorithms was stopped")
        const last = Python.marked(result.stdout).at(-1)
        const decoded = last === undefined ? undefined : decodeCatalog(last)
        if (!decoded || Exit.isFailure(decoded)) return fail("QGIS's Python ended without a valid list of algorithms")
        if (!decoded.value.ok) return fail(decoded.value.error)
        return Effect.succeed(decoded.value)
      }),
    )
}

async function isDirectory(target: string) {
  return fsp.stat(target).then(
    (stats) => stats.isDirectory(),
    () => false,
  )
}

/**
 * Asks QGIS whether it reads each value given for a CRS, before the user is asked. A check that cannot answer lets the
 * run go on.
 */
function readCoordinateSystems(
  runtime: Runtime.Interface,
  install: Installs.Install,
  given: ReturnType<typeof Plan.coordinateSystems>,
  cwd: string | undefined,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    const unknown = given.map(() => true)
    const ran = yield* Effect.exit(
      runtime.run({
        ...python(install, Python.CRS, { values: given.map((entry) => entry.value) }),
        // A layer's path is read from where the run will read it.
        cwd,
        delivery: { mode: "collect" },
        clocks: { total: CRS_TIMEOUT },
        signal,
      }),
    )
    if (Exit.isFailure(ran)) {
      yield* Effect.logWarning("the CRS check did not start", { cause: String(ran.cause) })
      return unknown
    }
    const result = ran.value
    if (result.reason === "abort") {
      return yield* new Engine.Failure({ code: "cancelled", message: "the check was cancelled" })
    }
    const decoded = decodeCrsReport(Python.marked(result.stdout).at(-1))
    if (Exit.isSuccess(decoded) && decoded.value.ok && decoded.value.read.length === given.length) {
      return decoded.value.read
    }
    yield* Effect.logWarning("the CRS check gave no answer", { reason: result.reason, stderr: tail(result.stderr) })
    return unknown
  })
}

/** Surveys the data a run names before the user is asked, with QGIS's GDAL. */
function inspectData(
  runtime: Runtime.Interface,
  install: Installs.Install,
  request: ReturnType<typeof Plan.survey>["request"],
  signal: AbortSignal,
) {
  return runtime
    .run({
      ...python(install, Reader.INSPECT, request),
      delivery: { mode: "collect" },
      clocks: { idle: READ_IDLE },
      signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) => {
        const details = { stderr: tail(result.stderr) }
        if (result.reason === "abort") {
          return Effect.fail(new Engine.Failure({ code: "cancelled", message: "the check was cancelled", details }))
        }
        if (result.reason === "idle") {
          const message = `checking the data reported nothing for ${READ_IDLE}`
          return Effect.fail(new Engine.Failure({ code: "timeout", message, details }))
        }
        const decoded = decodeInspection(Python.marked(result.stdout).at(-1))
        if (Exit.isFailure(decoded)) {
          const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
          const message = `QGIS's Python exited with ${ending} without a valid report`
          return Effect.fail(new Engine.Failure({ code: "crashed", message, details }))
        }
        return Effect.succeed(decoded.value)
      }),
    )
}

function execute(
  runtime: Runtime.Interface,
  install: Installs.Install,
  params: typeof RunParams.Type,
  algorithm: Catalog.Algorithm,
  slots: readonly Plan.Slot[],
  before: ReadonlySet<string>,
  context: Engine.MethodContext,
) {
  // The parameters QGIS's errors name, for the answer to describe.
  const named = new Set<string>()
  let noise = ""
  let stderr = ""
  const pending = { stdout: "", stderr: "" }
  // From the algorithm's start on each stream, to the process's end: the result can overtake what the other stream
  // still carries.
  const running = { stdout: false, stderr: false }
  let outcome: Extract<typeof Event.Type, { type: "result" }> | undefined

  /** A line the process wrote itself, as GDAL and PROJ do: told as it is, by when it came, never by what it says. */
  const written = (text: string, stream: "stdout" | "stderr") => {
    if (!text.trim()) return
    noise = tail(`${noise}${text}\n`)
    if (running[stream]) context.progress({ level: "console", text })
  }

  const line = (text: string, stream: "stdout" | "stderr") => {
    if (stream === "stderr") stderr = tail(`${stderr}${text}\n`)
    const payload = Python.marked(text)[0]
    const decoded = payload === undefined ? undefined : decodeEvent(payload)
    if (!decoded || Exit.isFailure(decoded)) return written(text, stream)
    const event = decoded.value
    if (event.type === "begin") {
      running[stream] = true
      // The caller's clock for silence starts here: QGIS says nothing while it starts.
      if (stream === "stdout") context.progress({ begun: true })
      return
    }
    if (stream === "stderr") return
    if (event.type === "result") {
      outcome = event
      return
    }
    if (event.type === "progress") return context.progress({ percent: event.percent })
    if (event.level === "info" && RESULTS.test(event.text)) return
    if (event.level === "error") for (const name of Plan.named(algorithm, event.text)) named.add(name)
    context.progress({ level: event.level, text: event.text })
  }

  // Each stream breaks into lines of its own: a line one leaves unfinished is not finished by the other.
  const onChunk = (chunk: string, stream: "stdout" | "stderr") => {
    const lines = (pending[stream] + chunk).split(/\r?\n/)
    pending[stream] = lines.pop() ?? ""
    for (const text of lines) line(text, stream)
    if (pending[stream].length <= LINE_LIMIT) return
    noise = tail(`${noise}${pending[stream]}`)
    pending[stream] = ""
  }

  return runtime
    .run({
      ...python(install, Python.RUN, { algorithm: params.algorithm, parameters: params.parameters }),
      cwd: params.cwd,
      delivery: { mode: "incremental", source: "all", onChunk },
      // The caller ends a run: how long one may take, only GeoAgent can judge.
      clocks: { total: Duration.infinity },
      signal: context.signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          if (pending.stdout) line(pending.stdout, "stdout")
          if (pending.stderr) line(pending.stderr, "stderr")
          const details = { stderr, output: noise }
          if (result.reason === "abort") {
            // A stop can land after QGIS reported success, while it closes down; what it wrote is then whole.
            if (!outcome?.ok) yield* Effect.promise(() => Plan.discard(slots, before))
            return yield* new Engine.Failure({ code: "cancelled", message: "the run was cancelled", details })
          }
          if (outcome?.ok) {
            const outputs = (outcome.outputs ?? {}) as Record<string, unknown>
            return { ending: Plan.finished(result.durationMs, outputs) }
          }
          const left = yield* Effect.promise(() => Plan.discard(slots, before))
          if (!outcome) {
            const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
            const message = `QGIS's Python exited with ${ending} before reporting a result`
            return yield* new Engine.Failure({
              code: "crashed",
              message,
              details: { ...details, ending: Plan.crashed(result.durationMs, left) },
            })
          }
          const message = outcome.error ?? "the algorithm failed"
          for (const name of Plan.named(algorithm, message)) named.add(name)
          const ending = Plan.failed(result.durationMs, algorithm, named, left)
          return yield* new Engine.Failure({
            code: "algorithm-failed",
            message,
            details: { ...details, stage: outcome.stage, ending },
          })
        }),
      ),
    )
}

/** Reads a dataset with QGIS's GDAL, and words what it found for GeoAgent. */
function readData(
  runtime: Runtime.Interface,
  install: Installs.Install,
  params: typeof ReadParams.Type,
  signal: AbortSignal,
) {
  return runtime
    .run({
      ...python(install, Reader.READ, params),
      delivery: { mode: "collect", limit: READ_OUTPUT_LIMIT },
      clocks: { idle: READ_IDLE },
      signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) => {
        const details = { stderr: tail(result.stderr) }
        if (result.reason === "abort") {
          return Effect.fail(new Engine.Failure({ code: "cancelled", message: "the read was cancelled", details }))
        }
        if (result.reason === "idle") {
          const message = `reading reported nothing for ${READ_IDLE}`
          return Effect.fail(new Engine.Failure({ code: "timeout", message, details }))
        }
        if (result.reason === "output-limit") {
          const message = `reading wrote more than ${READ_OUTPUT_LIMIT} bytes`
          return Effect.fail(new Engine.Failure({ code: "crashed", message, details }))
        }
        const decoded = decodeReading(Python.marked(result.stdout).at(-1))
        if (Exit.isFailure(decoded)) {
          const ending = result.signal ? `signal ${result.signal}` : `code ${result.code}`
          const message = `QGIS's Python exited with ${ending} without a valid report`
          return Effect.fail(
            new Engine.Failure({ code: "crashed", message, details: { ...details, report: String(decoded.cause) } }),
          )
        }
        const report = decoded.value
        if (report.kind === "error") {
          return Effect.fail(
            new Engine.Failure({ code: "read-failed", message: report.message, details: { error: report.error } }),
          )
        }
        return Effect.succeed(Geodata.answer(report, params))
      }),
    )
}

function tail(text: string) {
  return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL)
}
