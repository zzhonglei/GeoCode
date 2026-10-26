export * as GeoOsm from "./osm.js"

import path from "node:path"
import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import { GeoEngine } from "./geoengine.js"

/** The parameters the OSM tools share, as GeoAgent reads them (docs/OSM.md, section 5). */
export const Area = Schema.String.annotate({
  description:
    'Where to look: the id of an area found with osmsearch, such as "R65066", or several joined by commas; "bbox:south,west,north,east" in degrees; "around:latitude,longitude,meters"; "around:<id>,meters" for an object and everything within that distance of it; or "file:<path>" of a boundary file in any coordinate system, with "|layername=<name>" for one of its layers. Latitude always comes first. An area of more than 8 separate parts is counted and asked for as the box around them all, so places far apart are better looked at and downloaded one at a time.',
})

export const Tags = Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
  description:
    'Tag filters, any of which a feature may meet: "key=value"; "key" for any value; "key~regex"; "key!~regex" for the key with a value not matching, such as "amenity!~bench|waste_basket"; or conditions in brackets that must all hold, such as "[natural=water][water=reservoir]". Regexes are unanchored and case-sensitive. A candidate\'s category from osmsearch can be given as it stands.',
})

export const Fields = Schema.Array(Schema.String).annotate({
  description:
    'Tag keys to keep as columns besides those kept anyway, such as ["name:en", "addr:full"]; ["*"] keeps every tag, in one column, osm_tags.',
})

export const Output = Schema.String.annotate({
  description:
    'The GeoPackage to write, absolute or relative to the session\'s directory, such as "data/campus.gpkg". A file already there is never overwritten: the new one gets a number after its name.',
})

export const Label = Schema.String.annotate({
  description: "Short label for this download, 3-5 words in the user's language, shown to the user",
})

/** What GeoAgent reads when GeoEngine did not answer; a request written wrong is told how to write it right. */
const failureMessage = (failure: GeoEngine.Failure, tool: string) => {
  if (failure.code === "invalid" || failure.code === "not-ready") return failure.message
  if (failure.code === "invalid-params") return `${failure.message}.`
  if (failure.code === "refused") return `OpenStreetMap's server refused the query: ${failure.message}`
  if (failure.code === "unanswered") {
    return "OpenStreetMap's public servers cannot be reached from here, or are too busy to answer right now."
  }
  if (failure.code === "stalled") {
    const seconds = stalledFor(failure)
    return `No progress for ${seconds === undefined ? "too long" : `${Math.round(seconds / 60)} minutes`}: OpenStreetMap's public servers were too busy, or did not answer.${tool.startsWith("osmget") ? " Nothing was written." : ""}`
  }
  if (failure.code === "too-large") {
    return `OpenStreetMap's answer was too large to take (${failure.message}). Ask for fewer objects at a time.`
  }
  if (failure.code === "unwritable") return `Nothing was downloaded: no file can be written in ${failure.message}.`
  return "The OSM tools are not available right now. Tell the user; restarting GeoCode may fix it."
}

const decodeStalled = Schema.decodeUnknownExit(Schema.Struct({ seconds: Schema.Number }))

/** How long a call went without progress before it stopped. */
const stalledFor = (failure: GeoEngine.Failure) => {
  const decoded = decodeStalled(failure.details)
  return Exit.isSuccess(decoded) ? decoded.value.seconds : undefined
}

/**
 * A failure as the tool row tells it (docs/OSM.md, section 9): its kind, with the words that say what was wrong with
 * the request or the folder it was to write in, and how long a stalled call waited.
 */
const failureOf = (failure: GeoEngine.Failure) => {
  const seconds = failure.code === "stalled" ? stalledFor(failure) : undefined
  const said = ["refused", "invalid", "invalid-params", "unwritable"].includes(failure.code)
    ? failure.message
    : undefined
  return {
    code: failure.code,
    ...(said === undefined ? {} : { said }),
    ...(seconds === undefined ? {} : { seconds }),
  }
}

/**
 * Ends a call as failed, its tool row told how: what `shown` already holds of the call, with the failure. The call's
 * last metadata is kept on its failed state.
 */
export const failed =
  (tool: string, context: Tool.Context, shown: () => Record<string, unknown> = () => ({})) =>
  (failure: GeoEngine.Failure) =>
    Effect.logWarning(`${tool} failed`, {
      code: failure.code,
      message: failure.message,
      details: failure.details,
    }).pipe(
      Effect.andThen(context.progress({ ...shown(), failure: failureOf(failure) })),
      Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure, tool) }))),
    )

/** The area with the path of a boundary file made absolute, as read and write resolve theirs. */
export const resolveArea = (access: FileAccess.Interface, area: string) =>
  Effect.gen(function* () {
    if (!/^file:/i.test(area.trim())) return area
    const [file, ...layer] = area.trim().slice("file:".length).split("|")
    const target = yield* access.resolve({ path: file.trim(), kind: "file" })
    return ["file:" + target.absolute, ...layer].join("|")
  })

/**
 * Asks GeoEngine, before the user is asked, whether a call could start: GeoCode's Python environment ready, waited for
 * as a call waits, the params whole and the boundary file there. It runs nothing; how an area or tags are written is
 * checked once the call starts, as reading one names OSM objects that only OSM's servers know.
 */
export const check = (action: "search" | "probe" | "objects" | "features", params: object) =>
  GeoEngine.call("osm.check", { ...params, action })

/** A path as GeoAgent gave it: relative to the session's directory when it lies in it. */
const shown = (directory: string, file: string) => {
  const relative = path.relative(directory, file)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file
}

/** An Overpass time to the minute, as "2026-10-24 21:00 UTC". */
const minute = (time: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(time)
  return match ? `${match[1]} ${match[2]} UTC` : time
}

const count = (value: number, noun: string) => `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`

/** What a download is missing, as the tool row tells it; the answer says the same in English. */
const Gap = Schema.Union([
  Schema.Struct({ part: Schema.Array(Schema.Number), said: Schema.String }),
  Schema.Struct({ absent: Schema.Array(Schema.String) }),
  Schema.Struct({ unassembled: Schema.Array(Schema.String) }),
  Schema.Struct({ undownloaded: Schema.Array(Schema.String), code: Schema.Literals(["stalled", "unanswered"]) }),
  Schema.Struct({ said: Schema.String }),
])

const Downloaded = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    layers: Schema.Record(Schema.String, Schema.Number),
    timestamp: Schema.String,
    fields: Schema.Array(Schema.String),
    dropped: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
    missing: Schema.Array(Schema.String),
    gaps: Schema.Array(Gap),
  }),
  Schema.Struct({
    empty: Schema.Literal(true),
    missing: Schema.Array(Schema.String),
    gaps: Schema.Array(Gap),
    timestamp: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ refused: Schema.Number, limit: Schema.Number }),
])
const decodeDownloaded = Schema.decodeUnknownExit(Downloaded)

/** What a look or a download tells as it goes (docs/OSM.md, section 9), as GeoEngine passes it on. */
const Progress = Schema.Struct({
  osm: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("step"),
      step: Schema.Literals(["area", "count", "download", "assemble", "write"]),
    }),
    Schema.Struct({ type: Schema.Literal("counted"), features: Schema.NullOr(Schema.Number), parts: Schema.Number }),
    Schema.Struct({ type: Schema.Literal("part"), part: Schema.Number, parts: Schema.Number }),
    Schema.Struct({ type: Schema.Literal("received"), bytes: Schema.Number }),
    Schema.Struct({
      type: Schema.Literal("server"),
      asking: Schema.Boolean,
      arriving: Schema.Boolean,
      busy: Schema.Boolean,
    }),
    Schema.Struct({ type: Schema.Literal("waiting"), quiet: Schema.Number }),
    // GeoEngine's own: the call waits for the look or download before it, then begins.
    Schema.Struct({ type: Schema.Literal("queued") }),
    Schema.Struct({ type: Schema.Literal("started") }),
  ]),
})
const decodeProgress = Schema.decodeUnknownExit(Progress)

/**
 * A look's state as its tool row shows it while it runs: whether it waits for the call before it (docs/OSM.md,
 * section 9).
 */
export const queue = (context: Tool.Context) => (data: unknown) => {
  const decoded = decodeProgress(data)
  if (Exit.isFailure(decoded)) return Effect.void
  const type = decoded.value.osm.type
  return type === "queued" || type === "started" ? context.progress({ queued: type === "queued" }) : Effect.void
}

/** Keys listed one by one in the answer; the rest are counted together, with how few features carry each. */
const DROPPED_SHOWN = 40

/**
 * The answer of a download: what was written, what each layer holds, which keys were kept and dropped, and what is
 * missing; and the same for the tool row, the file's path as GeoAgent would give it.
 */
export const downloadAnswer = (result: unknown, directory: string, what: string) => {
  const decoded = decodeDownloaded(result)
  if (Exit.isFailure(decoded)) {
    return Effect.fail(new GeoEngine.Failure({ code: "unreadable", message: String(decoded.cause) }))
  }
  const done = decoded.value
  const answered = (content: string, shown: object) => Effect.succeed({ content, shown })
  const missing = "missing" in done && done.missing.length ? [`Missing: ${done.missing.join("; ")}.`] : []
  if ("refused" in done) {
    return answered(
      `${what} holds about ${count(done.refused, "feature")}, more than a download from OpenStreetMap's public servers can take (${count(done.limit, "feature")}), so nothing was downloaded. Download a smaller area, or fewer kinds of features at a time.`,
      { refused: done.refused, limit: done.limit },
    )
  }
  if ("empty" in done) {
    // Nothing from a server that stopped early, or only objects whose geometry could not be assembled, is not that
    // OpenStreetMap has nothing.
    const opening = done.gaps.some((gap) => "said" in gap)
      ? `Nothing was written for ${what}: OpenStreetMap's server stopped before it answered in full.`
      : done.gaps.some((gap) => "unassembled" in gap)
        ? `Nothing was written for ${what}.`
        : `OpenStreetMap has nothing for ${what}, so no file was written.`
    return answered([opening, ...missing].join("\n"), {
      empty: true,
      gaps: done.gaps,
      timestamp: done.timestamp,
    })
  }
  const layers = Object.entries(done.layers).map(([layer, features]) => `  ${layer}: ${count(features, "feature")}`)
  const listed = done.dropped.slice(0, DROPPED_SHOWN).map(([key, features]) => `${key} ${features}`)
  const rest = done.dropped.slice(DROPPED_SHOWN)
  const others = rest.length ? [`and ${count(rest.length, "more key")}, on at most ${rest[0][1]} features each`] : []
  const dropped = done.dropped.length
    ? [`Dropped keys, with how many features carried each: ${[...listed, ...others].join(", ")}.`]
    : []
  return answered(
    [
      `Wrote ${shown(directory, done.path)}, with OpenStreetMap data as of ${minute(done.timestamp)}:`,
      ...layers,
      "",
      `Columns: ${done.fields.join(", ")}.`,
      ...dropped,
      ...missing,
    ].join("\n"),
    {
      path: shown(directory, done.path),
      layers: done.layers,
      timestamp: done.timestamp,
      fields: done.fields,
      gaps: done.gaps,
    },
  )
}

/**
 * A download's state as its tool row shows it (docs/OSM.md, section 9), kept in the call's metadata: its label, when
 * it began, each step with when it began and ended, the count and the part, the bytes received, when it last made
 * progress, what it waits on (a query out, an answer arriving, or every instance busy), and whether it waits for the
 * call before it.
 */
export const watch = (context: Tool.Context, label: string) => {
  const started = Date.now()
  const steps: { step: string; started: number; ended?: number }[] = []
  let counted: { features: number | null; parts: number } | undefined
  let part: { part: number; parts: number } | undefined
  let received: number | undefined
  let progressed = started
  let asking = false
  let arriving = false
  let busy = false
  let queued = false

  const state = () => ({
    description: label,
    started,
    steps: steps.map((step) => ({ ...step })),
    ...(counted ? { counted } : {}),
    ...(part ? { part } : {}),
    ...(received === undefined ? {} : { received }),
    progressed,
    asking,
    arriving,
    busy,
    queued,
  })
  const moved = () => {
    progressed = Date.now()
  }
  const heed = (data: unknown) => {
    const decoded = decodeProgress(data)
    if (Exit.isFailure(decoded)) return Effect.void
    const event = decoded.value.osm
    if (event.type === "step") {
      const last = steps.at(-1)
      if (last) last.ended = Date.now()
      steps.push({ step: event.step, started: Date.now() })
    }
    if (event.type === "counted") counted = { features: event.features, parts: event.parts }
    if (event.type === "part") part = { part: event.part, parts: event.parts }
    if (event.type === "received") received = event.bytes
    if (event.type === "server") {
      asking = event.asking
      arriving = event.arriving
      busy = event.busy
    }
    queued = event.type === "queued"
    // The Python knows when it last made progress: an answer it turned down was received, but was none.
    if (event.type === "waiting") progressed = Date.now() - event.quiet * 1000
    if (event.type !== "waiting" && event.type !== "server") moved()
    return context.progress(state())
  }
  /** The state once the download has ended, its last step closed. */
  const ended = () => {
    const last = steps.at(-1)
    if (last && last.ended === undefined) last.ended = Date.now()
    return state()
  }
  return { state, heed, ended }
}
