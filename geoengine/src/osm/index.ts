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

/** The domain of GeoCode's Python environment, whose base the OSM tools run in (docs/OSM.md, section 2). */
const ENVIRONMENT_DOMAIN = "python"

/** Prefixes every line the Python answers with; anything else it prints is for the diagnostics. */
const MARKER = "__GEOCODE_OSM__"

/**
 * The public services, in the order asked (docs/OSM.md, section 3): Overpass's official instance and its two named
 * backends first, then mirrors holding the whole planet. Written here alone and given to the Python with each call.
 */
export const SERVICES = {
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
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

/**
 * How long a call may make no progress before it stops (docs/OSM.md, section 7): longer than Overpass may compute a
 * query before it sends anything.
 */
const STALL_SECONDS = 300

/** How long a call waits for GeoCode's Python environment to be ready, as just after the app started. */
const ENVIRONMENT_TIMEOUT = "100 seconds"

/** Nominatim is asked at most once a second, the whole app's calls counted together. */
const NOMINATIM_GAP_MS = 1000

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

/** What a call tells its tool row as it goes (docs/OSM.md, section 9), passed on as the Python wrote it. */
const Shown = Schema.Union([
  Schema.Struct({ type: Schema.Literal("step"), step: Schema.String }),
  Schema.Struct({ type: Schema.Literal("counted"), features: Schema.NullOr(Schema.Number), parts: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("part"), part: Schema.Number, parts: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("received"), bytes: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("busy") }),
  // Seconds since the call last made progress, while a request waits.
  Schema.Struct({ type: Schema.Literal("waiting"), quiet: Schema.Number }),
])

const Event = Schema.Union([
  Shown,
  Schema.Struct({ type: Schema.Literal("nominatim") }),
  Schema.Struct({ type: Schema.Literal("overpass"), index: Schema.Number }),
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

export const capability = (services: Services = SERVICES, stall = STALL_SECONDS): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const runtime = yield* Runtime.Service
    const environment = yield* Deferred.make<string>()
    // A search asks Nominatim, whose limit counts every call together: one search at a time, each told how long to
    // wait after the last one's request.
    const searching = yield* Semaphore.make(1)
    let nominatimAt = 0
    // The Overpass instance that answered last, which the next call starts from rather than waiting out one found busy.
    let overpass = 0

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
        const wait = Math.max(0, nominatimAt + NOMINATIM_GAP_MS - Date.now()) / 1000
        const request = {
          ...params,
          action,
          tool: TOOLS[action],
          marker: MARKER,
          agent: AGENT,
          services,
          stall,
          wait,
          overpass,
        }
        return yield* execute(runtime, python, request, context, {
          nominatim: () => {
            nominatimAt = Date.now()
          },
          overpass: (index) => {
            overpass = index
          },
        })
      })

    const method =
      (action: Action): Engine.Method =>
      (raw, context) =>
        Effect.gen(function* () {
          const params = yield* validate(action, raw)
          const running = call(action, params, context)
          return yield* action === "search" ? searching.withPermits(1)(running) : running
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

interface Learned {
  readonly nominatim: () => void
  readonly overpass: (index: number) => void
}

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
    if (event.type === "nominatim") learned.nominatim()
    if (event.type === "overpass") learned.overpass(event.index)
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
            return yield* new Engine.Failure({ code: "cancelled", message: "the call was cancelled" })
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
