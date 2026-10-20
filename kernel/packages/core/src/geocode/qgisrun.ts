export * as QgisRunTool from "./qgisrun.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Array as Arr, Effect, Exit, Schema } from "effect"
import fs from "fs/promises"
import { FileAccess } from "../file-access.js"
import type { Location } from "../location.js"
import type { Permission } from "../permission.js"
import { Wildcard } from "../util/wildcard.js"
import { GeoAnswer } from "./answer.js"
import { GeoEngine } from "./geoengine.js"
import { GeoRunActivity } from "./run-activity.js"

export const name = "qgisrun"

export const description = `Run a QGIS Processing algorithm.

- Read the algorithm's documentation with qgisdoc (action "help") before running it. Parameter names, types and defaults differ between algorithms and between QGIS versions.
- QGIS runs here without its interface or a project, so there are no map layouts and no open layers to refer to. Give inputs and outputs as files: results written to "memory:" or TEMPORARY_OUTPUT are lost when the run ends.
- In a multi-step workflow, reduce the data first (clip, filter), then run the expensive steps (joins, classification).
- For layers with many features, such as POIs or grids, use .gpkg for inputs and outputs; it is much faster. Otherwise prefer .shp or .geojson.
- GeoJSON output MUST be in WGS 84 (EPSG:4326), as the GeoJSON standard requires; never write it in another CRS.

Coordinate reference systems:
- QGIS does not check whether the input's CRS suits the algorithm, and qgisdoc often does not say which one it needs. Before running, decide whether the data must be in a projected CRS (metres or feet) or may stay in a geographic CRS (degrees).
- An algorithm that takes or produces distances or areas, such as buffers, lengths, densities or slopes, MUST run on projected data. On geographic data a distance is read in degrees: a 500 m buffer becomes 500 degrees.
- Reproject first, with native:reprojectlayer for vectors or gdal:warpreproject for rasters.`

const DEFAULT_TIMEOUT = 60
const MIN_TIMEOUT = 10

/** The silence allowed before the algorithm begins, at the least: QGIS says nothing while it starts, slowly when cold. */
const START_TIMEOUT = 120

/** The messages the interface is given, the latest; the answer keeps the latest that fit. */
const SHOWN_MESSAGES = 500

export const Input = Schema.Struct({
  algorithm: Schema.String.annotate({ description: 'The full algorithm ID, for example "native:buffer"' }),
  parameters: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      'The algorithm\'s parameters by name, as its documentation lists them, for example {"INPUT": "roads.shp", "DISTANCE": 100, "OUTPUT": "roads_buffer.gpkg"}',
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "A short 3-5 word label for this step, in the user's language, displayed to the user",
  }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT}, minimum: ${MIN_TIMEOUT}). Raise it for large datasets, heavy computation, and gdal: algorithms on large data`,
  }),
})

/**
 * Algorithms whose harm cannot be undone: they empty a layer, burn values into an existing raster, rewrite a CRS, run
 * SQL, write into a database, or send data off the computer. Asked about even where the rules allow the tool. A
 * few are missed; reversible changes to an input, such as an index or pyramids, are not listed.
 */
const GUARDED = new Set([
  "native:truncatetable",
  "gdal:rasterize_over",
  "gdal:rasterize_over_fixed_value",
  "native:definecurrentprojection",
  "qgis:definecurrentprojection",
  "gdal:assignprojection",
  "native:spatialiteexecutesql",
  "native:spatialiteexecutesqlregistered",
  "native:postgisexecutesql",
  "native:importintospatialite",
  "native:importintospatialiteregistered",
  "qgis:importintospatialite",
  "native:importintopostgis",
  "gdal:importvectorintopostgisdatabaseavailableconnections",
  "gdal:importvectorintopostgisdatabasenewconnection",
  "native:fileuploader",
  "native:uploadgpsdata",
])

const Entry = Schema.Struct({ name: Schema.String, value: Schema.Unknown })

const Plan = Schema.Struct({
  header: Schema.String,
  notes: Schema.Array(Schema.String),
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  algorithm: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    translations: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, description: Schema.String })),
  }),
  inputs: Schema.Array(Entry),
  outputs: Schema.Array(
    Schema.Struct({
      ...Entry.fields,
      files: Schema.Array(Schema.String),
      folder: Schema.Boolean,
      /** Where an output that is no file writes, such as a database. */
      place: Schema.optionalKey(Schema.String),
    }),
  ),
  options: Schema.Array(Entry),
})
type Plan = typeof Plan.Type

const Refused = Schema.Struct({ refused: Schema.String })
const decodeLocated = Schema.decodeUnknownExit(
  Schema.Union([Refused, Schema.Struct({ files: Schema.Array(Schema.String) })]),
)
const decodePrepared = Schema.decodeUnknownExit(Schema.Union([Refused, Schema.Struct({ plan: Plan })]))
const decodeEnding = Schema.decodeUnknownExit(Schema.Struct({ ending: Schema.String }))
const decodeProgress = Schema.decodeUnknownExit(
  Schema.Union([
    Schema.Struct({ begun: Schema.Literal(true) }),
    Schema.Struct({ percent: Schema.Number }),
    Schema.Struct({ level: Schema.String, text: Schema.String }),
  ]),
)

type Outcome = "finished" | "failed" | "timeout" | "crashed" | "refused"

interface Message {
  readonly level: string
  readonly text: string
}

/** What GeoAgent reads when GeoEngine cannot answer; a QGIS that is not ready comes with what to do about it. */
const failureMessage = (failure: GeoEngine.Failure) => {
  if (failure.code === "not-ready") return failure.message
  if (failure.code === "catalog-failed") return "QGIS could not list its algorithms."
  // Only the survey of the data before asking ends so; a run that does says so in its answer.
  if (failure.code === "timeout" || failure.code === "crashed")
    return "Checking the data the parameters name stopped without an answer, so nothing was run."
  return GeoEngine.UNAVAILABLE
}

const failed = (failure: GeoEngine.Failure) =>
  Effect.logWarning("qgisrun failed", { code: failure.code, message: failure.message, details: failure.details }).pipe(
    Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure) }))),
  )

const ask = <A>(method: string, params: unknown, decode: (input: unknown) => Exit.Exit<A, unknown>) =>
  GeoEngine.call(method, params).pipe(
    Effect.flatMap((result) => {
      const decoded = decode(result)
      return Exit.isSuccess(decoded)
        ? Effect.succeed(decoded.value)
        : Effect.fail(new GeoEngine.Failure({ code: "unreadable", message: String(decoded.cause) }))
    }),
    Effect.catch(failed),
  )

/** A monotonic clock, so a computer waking from sleep does not find every run silent for as long as it slept. */
const now = () => performance.now()

/** Whole seconds, or tenths below one, as GeoEngine writes them. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`

/** The facts before the reasons, apart: the interface shows only what follows them. */
const reasonsOf = (text: string) => text.slice(text.indexOf("\n\n") + 2)

/** GeoAgent's label for the step, left out when it wrote none: metadata is stored as JSON, which has no undefined. */
const labelOf = (input: { readonly description?: string }) =>
  input.description === undefined ? {} : { description: input.description }

type Verdict = typeof Permission.Effect.Type

/**
 * A run asks when its algorithm is on the list, it writes outside the project, or it writes somewhere that is no file,
 * even where the rules allow the tool, unless "always allow" was given for each of those: by algorithm, by directory,
 * and by database. A saved "*" allows the tool, not these.
 */
export const evaluate = (
  event: { readonly action: string; readonly effect: Verdict; readonly metadata?: Record<string, unknown> },
  saved: ReadonlyArray<{ readonly action: string; readonly resource: string }>,
): Verdict => {
  const guards = event.metadata?.guards
  if (event.action !== name || event.effect !== "allow" || !Array.isArray(guards)) return event.effect
  const kept = saved.filter((item) => item.action === name && item.resource !== "*")
  const allowed = guards.every(
    (guard) => typeof guard === "string" && kept.some((item) => Wildcard.match(guard, item.resource)),
  )
  return allowed ? "allow" : "ask"
}

export const make = (permission: Permission.Interface, access: FileAccess.Interface, location: Location.Interface) => {
  /**
   * One asking for the whole run: the rules, the list, every directory outside the project it writes to, and every
   * place that is no file, such as a database, where a table of the same name may be replaced.
   */
  const authorize = (plan: Plan, input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      const resolved = yield* Effect.forEach(plan.outputs, (output) =>
        Effect.forEach(output.files, (file) =>
          access.resolve({ path: file, kind: output.folder ? "directory" : "file" }),
        ).pipe(Effect.map((targets) => ({ output, targets }))),
      )
      const outputs = resolved.map(({ output, targets }) => ({
        ...output,
        external: targets.some((target) => target.externalDirectory !== undefined),
      }))
      const places = Arr.dedupe(plan.outputs.flatMap((output) => (output.place === undefined ? [] : [output.place])))
      const external = Arr.dedupeWith(
        resolved.flatMap(({ targets }) =>
          targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        ),
        (left, right) => left.resource === right.resource,
      )
      const guarded = GUARDED.has(plan.algorithm.id)
      const guards = [
        ...(guarded ? [{ resource: plan.algorithm.id, save: plan.algorithm.id }] : []),
        // The directory the card names, not the repository it is in, which other tools save.
        ...external.map((item) => ({ resource: item.resource, save: item.resource })),
        ...places.map((place) => ({ resource: place, save: place })),
      ]
      yield* permission.assert({
        action: name,
        // The algorithm always, so the rules written for it hold wherever the run writes.
        resources: Arr.dedupe([plan.algorithm.id, ...guards.map((guard) => guard.resource)]),
        save: guards.length ? guards.map((guard) => guard.save) : ["*"],
        metadata: {
          ...labelOf(input),
          algorithm: plan.algorithm,
          inputs: plan.inputs,
          options: plan.options,
          outputs,
          external: external.map((item) => item.directory),
          elsewhere: plan.outputs.flatMap((output) => (output.place === undefined ? [] : [output.value])),
          guarded,
          guards: guards.map((guard) => guard.resource),
        },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
    })

  /** Runs the plan, ending it after `timeout` seconds without a word from QGIS. */
  const run = (plan: Plan, input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      // Allowed and about to run: the location is not idle until the run ends.
      yield* GeoRunActivity.hold(location)
      const timeout = Math.max(MIN_TIMEOUT, input.timeout ?? DEFAULT_TIMEOUT)
      const messages: Message[] = []
      let percent: number | undefined
      const started = now()
      // The interface counts the run from here, not from the call, which includes the wait for the user's answer.
      const since = Date.now()
      let heard = started
      let begun = false
      let shown = 0
      let changed = false
      // In seconds.
      const limit = () => (begun ? timeout : Math.max(timeout, START_TIMEOUT))

      const state = (ending?: { readonly outcome: Outcome; readonly text: string }) => ({
        ...labelOf(input),
        started: since,
        algorithm: plan.algorithm,
        notes: plan.notes,
        messages: messages.slice(-SHOWN_MESSAGES),
        ...(percent === undefined ? {} : { percent }),
        ...(ending ? { outcome: ending.outcome, ending: ending.text } : {}),
      })
      const show = Effect.suspend(() => {
        changed = false
        shown = now()
        return context.progress(state())
      })
      // Many algorithms report a line per feature: the interface is told at most four times a second.
      const heed = (data: unknown) =>
        Effect.suspend(() => {
          heard = now()
          const decoded = decodeProgress(data)
          if (Exit.isFailure(decoded)) return Effect.void
          if ("begun" in decoded.value) begun = true
          else if ("percent" in decoded.value) percent = decoded.value.percent
          else messages.push({ level: decoded.value.level, text: decoded.value.text })
          if (now() - shown >= 250) return show
          changed = true
          return Effect.void
        })
      const watch = Effect.gen(function* () {
        while (now() - heard < limit() * 1000) {
          yield* Effect.sleep("250 millis")
          if (changed && now() - shown >= 250) yield* show
        }
      })

      yield* show
      const ran = yield* Effect.raceFirst(
        GeoEngine.call(
          "qgis.run",
          { algorithm: plan.algorithm.id, parameters: plan.parameters, cwd: location.directory },
          heed,
        ).pipe(Effect.exit),
        watch.pipe(Effect.as(undefined)),
      )

      // An algorithm may warn once per feature, so only the end of what QGIS said is kept.
      const answer = (outcome: Outcome, ending: string) => {
        const around = `${plan.header}\n${ending}`
        const said = GeoAnswer.lastPart(messages.map((message) => message.text).join("\n"), {
          lines: around.split("\n").length,
          bytes: Buffer.byteLength(around, "utf-8"),
        })
        return {
          content: [plan.header, ...(said.cut ? [GeoAnswer.CUT] : []), said.text, ending].filter(Boolean).join("\n\n"),
          metadata: state({ outcome, text: ending }),
        }
      }
      if (ran === undefined) {
        const left = yield* Effect.promise(() => written(plan))
        const ending = [
          `Stopped after ${seconds(now() - started)}, with no progress for the last ${limit()} s.`,
          ...(left.length ? ["These outputs may be incomplete:", ...left.map((file) => `- ${file}`)] : []),
        ].join("\n")
        return answer("timeout", ending)
      }
      if (Exit.isSuccess(ran)) {
        const decoded = decodeEnding(ran.value)
        if (Exit.isFailure(decoded)) {
          return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(decoded.cause) }))
        }
        return answer("finished", decoded.value.ending)
      }
      const failure = Exit.findErrorOption(ran)
      if (failure._tag === "None") return yield* Effect.failCause(ran.cause)
      const ending = decodeEnding(failure.value.details)
      if ((failure.value.code === "algorithm-failed" || failure.value.code === "crashed") && Exit.isSuccess(ending)) {
        return answer(failure.value.code === "crashed" ? "crashed" : "failed", ending.value.ending)
      }
      return yield* failed(failure.value)
    }).pipe(Effect.scoped)

  return {
    name,
    // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
    options: { codemode: false },
    description,
    input: Input,
    execute: (input: typeof Input.Type, context: Tool.Context) =>
      Effect.gen(function* () {
        const request = { algorithm: input.algorithm, parameters: input.parameters }
        const refused = (text: string) => ({
          content: text,
          metadata: { ...labelOf(input), outcome: "refused" as const, ending: reasonsOf(text) },
        })
        // Checked before asking, so the user is never asked about a run that cannot work.
        const located = yield* ask("qgis.locate", request, decodeLocated)
        if ("refused" in located) return refused(located.refused)
        // Resolved as read and write resolve theirs.
        const files = located.files.map((file) => FileAccess.resolvePath(location.directory, file))
        const prepared = yield* ask("qgis.prepare", { ...request, files, cwd: location.directory }, decodePrepared)
        if ("refused" in prepared) return refused(prepared.refused)
        yield* authorize(prepared.plan, input, context)
        return yield* run(prepared.plan, input, context)
      }).pipe(
        // As the built-in tools do: a refused permission or a missing session still ends as this tool's failure.
        Effect.mapError((error) =>
          error instanceof ToolFailure
            ? error
            : new ToolFailure({ message: `Unable to run ${input.algorithm}`, error }),
        ),
      ),
  }
}

/**
 * The files the plan writes that exist now. A numbered name is new, so what is there is the run's; folders, and
 * GeoPackages it adds a table to, were there before it.
 */
async function written(plan: Plan) {
  const added = (output: Plan["outputs"][number]) => typeof output.value === "string" && output.value.startsWith("ogr:")
  const files = plan.outputs.filter((output) => !output.folder && !added(output)).flatMap((output) => output.files)
  const present = await Promise.all(
    files.map((file) =>
      fs.stat(file).then(
        () => true,
        () => false,
      ),
    ),
  )
  return [...new Set(files.filter((_, index) => present[index]))]
}
