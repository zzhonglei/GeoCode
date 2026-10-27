export * as Osm from "./index.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Option, Schema, Semaphore, Stream } from "effect"
import { Bundled } from "../bundled.ts"
import { Engine } from "../engine.ts"
import { Geocodekit } from "../python/geocodekit.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"

const DOMAIN = "osm"

/** The domain of GeoCode's Python environment, whose base the OSM tools run in. */
const ENVIRONMENT_DOMAIN = "python"

/** Prefixes every line the Python answers with; anything else it prints is for the diagnostics. */
const MARKER = "__GEOCODE_OSM__"

/**
 * The public services: the Overpass instances free to all that hold the whole planet, the
 * official one at its own address alone, as its two servers are one instance. Written here alone and given to the
 * Python with each call.
 */
const SERVICES = {
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ],
  nominatim: "https://nominatim.openstreetmap.org/",
  photon: "https://photon.komoot.io/",
  wikidata: "https://www.wikidata.org/",
}

export type Services = typeof SERVICES

/** As the services' policies ask: the application, its version and where to find it, and nothing of the user. */
const AGENT = `GeoCode/${Geocodekit.PACKAGE.version} (+https://github.com/zzhonglei/GeoCode-Release)`

/**
 * How long a call may print nothing: the Python reports while a request waits, so only its own work counts, such as
 * assembling a large download's geometries.
 */
const IDLE_SECONDS = 300

/** How long calls wait, in seconds. */
export const TIMING = {
  /** How long a call may make no progress before it stops: longer than Overpass may compute and send nothing. */
  stall: 300,
  /** How long an Overpass instance that said it was busy is not asked again, as the official one's policy asks. */
  pause: 30,
  /** How long a probe of an instance is waited for: a server holds a request it has no slot for 15 seconds at most. */
  probe: 20,
}

export type Timing = typeof TIMING

/** How long a call waits for GeoCode's Python environment to be ready, as just after the app started. */
const ENVIRONMENT_TIMEOUT = "100 seconds"

/** Characters kept of what the Python printed besides its answer, for the diagnostics. */
const OUTPUT_TAIL = 16 * 1024

/** The name a download's unfinished file has; only such a file is removed, whatever else a line may claim. */
const PARTIAL = /^\..+\.\d+\.part\.gpkg$/

const EnvironmentReady = Schema.Struct({ status: Schema.Literal("ready"), base: Schema.String })

const Names = Schema.Array(Schema.String)

const SearchParams = Schema.Struct({
  name: Schema.String,
  context: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
})
const ProbeParams = Schema.Struct({
  area: Schema.String,
  term: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Names),
  keys: Schema.optionalKey(Names),
})
const ObjectsParams = Schema.Struct({ ids: Names, output: Schema.String, fields: Schema.optionalKey(Names) })
const FeaturesParams = Schema.Struct({
  area: Schema.String,
  tags: Names,
  geometry: Schema.optionalKey(Schema.Literals(["original", "point"])),
  fields: Schema.optionalKey(Names),
  output: Schema.String,
})

const DECODERS: Record<Action, (raw: unknown) => Exit.Exit<object, Schema.SchemaError>> = {
  search: Schema.decodeUnknownExit(SearchParams),
  probe: Schema.decodeUnknownExit(ProbeParams),
  objects: Schema.decodeUnknownExit(ObjectsParams),
  features: Schema.decodeUnknownExit(FeaturesParams),
}

const CheckParams = Schema.Struct({ action: Schema.Literals(["search", "probe", "objects", "features"]) })
const decodeCheckParams = Schema.decodeUnknownExit(CheckParams)

/** What a call tells its tool row as it goes, passed on as the Python wrote it. */
const Shown = Schema.Union([
  Schema.Struct({ type: Schema.Literal("step"), step: Schema.String }),
  Schema.Struct({ type: Schema.Literal("counted"), features: Schema.NullOr(Schema.Number), parts: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("part"), part: Schema.Number, parts: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("received"), bytes: Schema.Number }),
  // What the call waits on: a query out, an answer arriving, or every instance it may ask busy.
  Schema.Struct({
    type: Schema.Literal("server"),
    asking: Schema.Boolean,
    arriving: Schema.Boolean,
    busy: Schema.Boolean,
  }),
  // Seconds since the call last made progress, while a request waits.
  Schema.Struct({ type: Schema.Literal("waiting"), quiet: Schema.Number }),
])

const Event = Schema.Union([
  Shown,
  Schema.Struct({ type: Schema.Literal("overpass"), index: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("paused"), index: Schema.Number, seconds: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("partial"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), result: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    code: Schema.String,
    message: Schema.String,
    seconds: Schema.optionalKey(Schema.Number),
  }),
])
const isShown = Schema.is(Shown)

const decodeEnvironmentReady = Schema.decodeUnknownExit(EnvironmentReady)
const decodeEvent = Schema.decodeUnknownExit(Schema.fromJsonString(Event))

/** The tool each action answers, which geocodekit is told is running. */
const TOOLS = { search: "osmsearch", probe: "osmprobe", objects: "osmgetobjects", features: "osmgetfeatures" } as const

type Action = keyof typeof TOOLS

const exists = (target: string) => fsp.stat(target).then(Boolean, () => false)

/** The boundary file an area names, as "file:<path>|layername=<name>"; undefined for any other area. */
const boundaryOf = (area: string) => {
  const text = area.trim()
  return /^file:/i.test(text) ? text.slice("file:".length).split("|")[0].trim() : undefined
}

/**
 * An action's params as decoded, its output absolute and its boundary file there: a file or, as a File Geodatabase is,
 * a folder.
 */
const validate = (action: Action, raw: unknown) =>
  Effect.gen(function* () {
    const decoded = DECODERS[action](raw)
    if (Exit.isFailure(decoded)) {
      return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
    }
    const params: object = decoded.value
    if ("output" in params && typeof params.output === "string" && !path.isAbsolute(params.output)) {
      return yield* new Engine.Failure({ code: "invalid-params", message: `${params.output} is not absolute` })
    }
    const boundary = "area" in params && typeof params.area === "string" ? boundaryOf(params.area) : undefined
    if (boundary !== undefined) {
      const there = path.isAbsolute(boundary) && (yield* Effect.promise(() => exists(boundary)))
      if (!there) return yield* new Engine.Failure({ code: "invalid-params", message: `${boundary} does not exist` })
    }
    return params
  })

/**
 * The OSM tools, asking `services` and keeping when Nominatim was last asked in a file among `locks`, the app's lock
 * files.
 */
export const capability = (locks: string, services: Services = SERVICES, timing: Timing = TIMING): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const runtime = yield* Runtime.Service
    const environment = yield* Deferred.make<string>()
    // Looks and downloads ask Overpass, whose public instances give an IP address a few slots and whose policy rules
    // out parallel scripts: one at a time, each spreading its own queries over the instances.
    const asking = yield* Semaphore.make(1)
    // The Overpass instance that answered last, where the next search starts rather than waiting out one found busy;
    // and when each instance found busy may be asked again, by any call.
    let overpass = 0
    const pausedUntil = services.overpass.map(() => 0)

    yield* Effect.forkScoped(
      status.watch(ENVIRONMENT_DOMAIN).pipe(
        Stream.map((value) => decodeEnvironmentReady(value)),
        Stream.filter(Exit.isSuccess),
        Stream.runHead,
        Effect.flatMap((found) =>
          Option.isSome(found) ? Deferred.succeed(environment, found.value.value.base) : Effect.void,
        ),
      ),
    )

    const base = Deferred.await(environment).pipe(
      Effect.timeoutOption(ENVIRONMENT_TIMEOUT),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.fail(
              new Engine.Failure({
                code: "not-ready",
                message: "GeoCode's Python environment is still being prepared. Call the tool again in a minute.",
              }),
            ),
      ),
    )

    const call = (action: Action, params: object, context: Engine.MethodContext) =>
      Effect.gen(function* () {
        const python = yield* base
        const request = {
          ...params,
          action,
          tool: TOOLS[action],
          marker: MARKER,
          agent: AGENT,
          services,
          locks,
          ...timing,
          overpass,
          paused: pausedUntil.map((until) => Math.max(0, until - Date.now()) / 1000),
        }
        return yield* execute(runtime, python, request, context, {
          answered: (index) => {
            overpass = index
          },
          paused: (index, seconds) => {
            pausedUntil[index] = Date.now() + seconds * 1000
          },
        })
      })

    /**
     * A look or a download, once the one before it has ended. Its row is told, besides what the Python tells, when it
     * waits and when it begins.
     */
    const queued = (running: Effect.Effect<unknown, Engine.Failure>, context: Engine.MethodContext) =>
      Effect.gen(function* () {
        if (!(yield* Semaphore.takeIfAvailable(asking, 1))) {
          context.progress({ osm: { type: "queued" } })
          yield* Effect.raceFirst(Semaphore.take(asking, 1), cancelled(context.signal))
          context.progress({ osm: { type: "started" } })
        }
        return yield* running.pipe(Effect.ensuring(Semaphore.release(asking, 1)))
      })

    const method =
      (action: Action): Engine.Method =>
      (raw, context) =>
        Effect.gen(function* () {
          const params = yield* validate(action, raw)
          const running = call(action, params, context)
          // A search's queries can be done without and are brief: it does not wait behind a download.
          return yield* action === "search" ? running : queued(running, context)
        })

    /** Whether a call could start now, asked before the user is asked about it; runs nothing. */
    const check: Engine.Method = (raw) =>
      Effect.gen(function* () {
        const decoded = decodeCheckParams(raw)
        if (Exit.isFailure(decoded)) {
          return yield* new Engine.Failure({ code: "invalid-params", message: String(decoded.cause) })
        }
        yield* validate(decoded.value.action, raw)
        yield* base
        return {}
      })

    return {
      domain: DOMAIN,
      methods: {
        check,
        search: method("search"),
        probe: method("probe"),
        objects: method("objects"),
        features: method("features"),
      },
    }
  })

const cancellation = () => new Engine.Failure({ code: "cancelled", message: "the call was cancelled" })

/** Waits for an abort of the signal, and fails as a cancelled call. */
function cancelled(signal: AbortSignal) {
  return Effect.callback<never, Engine.Failure>((resume) => {
    const abort = () => resume(Effect.fail(cancellation()))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}

/** What a call's Python tells of the Overpass instances, which GeoEngine keeps for the calls after it. */
interface Learned {
  readonly answered: (index: number) => void
  readonly paused: (index: number, seconds: number) => void
}

/** Runs a call's Python, passing what it tells on to its row and what it learns of the instances to `learned`. */
function execute(
  runtime: Runtime.Interface,
  python: string,
  request: object,
  context: Engine.MethodContext,
  learned: Learned,
) {
  let outcome:
    | { readonly result: unknown }
    | { readonly code: string; readonly message: string; readonly seconds?: number }
    | undefined
  let printed = ""
  let pending = ""
  const partials = new Set<string>()

  const line = (text: string) => {
    const decoded = text.startsWith(MARKER) ? decodeEvent(text.slice(MARKER.length)) : undefined
    if (!decoded || Exit.isFailure(decoded)) {
      printed = tail(`${printed}${text}\n`)
      return
    }
    const event = decoded.value
    if (isShown(event)) context.progress({ osm: event })
    if (event.type === "overpass") learned.answered(event.index)
    if (event.type === "paused") learned.paused(event.index, event.seconds)
    if (event.type === "partial" && PARTIAL.test(path.basename(event.path))) partials.add(event.path)
    if (event.type === "result") outcome = { result: event.result }
    if (event.type === "failure") outcome = event
  }

  const onChunk = (chunk: string, stream: "stdout" | "stderr") => {
    if (stream === "stderr") {
      printed = tail(printed + chunk)
      return
    }
    const lines = (pending + chunk).split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const text of lines) line(text)
  }

  const program = `REQUEST = ${JSON.stringify(JSON.stringify(request))}\nimport geocodekit.osm._run\ngeocodekit.osm._run.main(REQUEST)\n`

  return runtime
    .run({
      ...Bundled.python(python, ["-"]),
      input: program,
      delivery: { mode: "incremental", source: "all", onChunk },
      clocks: { idle: `${IDLE_SECONDS} seconds` },
      signal: context.signal,
    })
    .pipe(
      Effect.mapError((error) => new Engine.Failure({ code: "start-failed", message: error.message })),
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          if (pending) line(pending)
          // The process has ended, or was killed and waited for, so a download it left unfinished can go.
          yield* Effect.promise(() =>
            Promise.all([...partials].map((file) => fsp.rm(file, { force: true }).catch(() => undefined))),
          )
          if (result.reason === "abort") {
            return yield* cancellation()
          }
          if (outcome && "result" in outcome) return outcome.result
          if (outcome) {
            return yield* new Engine.Failure({
              code: outcome.code,
              message: outcome.message,
              ...(outcome.seconds === undefined ? {} : { details: { seconds: outcome.seconds } }),
            })
          }
          const ending =
            result.reason === "idle"
              ? `printed nothing for ${IDLE_SECONDS} seconds`
              : result.signal
                ? `exited with signal ${result.signal}`
                : `exited with code ${result.code}`
          return yield* new Engine.Failure({
            code: "failed",
            message: `the OSM tool's Python ${ending} before it answered`,
            details: { output: printed },
          })
        }),
      ),
    )
}

function tail(text: string) {
  return text.length <= OUTPUT_TAIL ? text : text.slice(-OUTPUT_TAIL)
}
