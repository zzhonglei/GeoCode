export * as GeeRunTool from "./geerun.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import type { Location } from "../location.js"
import type { Permission } from "../permission.js"
import { ToolOutput } from "../tool-output.js"
import { GeoEngine } from "./geoengine.js"

export const name = "geerun"

export const description = `Run a Python script that uses Google Earth Engine, within a task.

- A task keeps what its scripts save, in a folder of its name in the GeoCode folder of the user's Earth Engine assets, across runs and conversations. Every call names one: "new_task" starts one, "task" continues one. Name a new task for its purpose and today's date, such as taipei-ndvi-20261008: 1 to 30 letters, digits, "_" or "-". Its folder is made when it first saves something; until then the task exists only in this conversation, and leaves nothing in the user's Earth Engine. A task that saved something can be continued from any conversation; any other name is refused.
- The answer starts with the task: its assets, with their titles and descriptions, and the latest other tasks. Then comes what the script printed.
- \`ee\` is imported and initialized with the user's Google Cloud project before the script starts. Do not call ee.Authenticate() or ee.Initialize().
- \`import geocode as gc\` to save to the task and read from it:
  - gc.save(data, "composite", title=..., description=..., region=..., scale=...) saves an ee.Image or ee.FeatureCollection to the task and returns it read from the saved asset. An image needs region, and scale or crs with crs_transform. Write title and description in the user's language: they are how the user, in the Code Editor, and later conversations know what the asset is. It waits for the export, which may take minutes. The same content saved before under the name is read as it is; other content replaces it.
  - gc.load("composite") reads an asset of this task, and gc.load("other-task/composite") one of another task. An asset outside GeoCode's folder is read by the full path the user gives, gc.load("projects/...").
- An export computes everything again at full resolution, and the first run that saves is slower; later runs read the saved asset instead of computing it again, which spares the user's Earth Engine quota. So save what is expensive and used again, typically the composite once it is checked, and what the user wants kept. Do not save quick looks, cheap steps, or what is still being adjusted. When computing fails with "Computation timed out" or "User memory limit exceeded", save the expensive step first and continue from it.
- Save to the task only with gc.save. Do not delete tasks or assets unless the user asks.
- Give the code as "script", or the path of a .py file as "path". It runs in the session's directory, with the Python configured for Earth Engine.
- What the script prints, and its errors, are all you get back, so print what you need. Bring results from Earth Engine with getInfo() and keep them small: statistics or a few values, not pixels or long lists.
- There is no time limit while the script waits for Earth Engine. A script that prints nothing and waits for no request to Earth Engine for two minutes is stopped.`

export const Input = Schema.Struct({
  task: Schema.optionalKey(Schema.String).annotate({
    description: 'The task to continue, by its name. Give this or "new_task"',
  }),
  new_task: Schema.optionalKey(Schema.String).annotate({
    description:
      'The task to start, named for its purpose and today\'s date, such as taipei-ndvi-20261008. Give this or "task"',
  }),
  script: Schema.optionalKey(Schema.String).annotate({ description: 'The Python code to run. Give this or "path"' }),
  path: Schema.optionalKey(Schema.String).annotate({
    description: 'The .py file to run, absolute or relative to the session\'s directory. Give this or "script"',
  }),
  description: Schema.String.annotate({
    description: "A short 3-5 word label for this step, in the user's language, displayed to the user",
  }),
})

/** Earth Engine's rule for asset names, shortened as GeoEngine's is: an export's description names task and asset. */
const TASK_NAME = /^[A-Za-z0-9_-]{1,30}$/

const Asset = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  saved: Schema.String,
  bands: Schema.optionalKey(Schema.Array(Schema.String)),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
})

const Space = Schema.Struct({
  assets: Schema.Array(Asset),
  /** Assets beyond those listed. */
  more: Schema.Number,
  others: Schema.Array(Schema.Struct({ name: Schema.String, assets: Schema.Number, updated: Schema.String })),
  /** Other tasks in all. */
  tasks: Schema.Number,
})

const Ran = Schema.Struct({
  outcome: Schema.Literals(["finished", "failed", "crashed", "idle"]),
  output: Schema.String,
  truncated: Schema.Boolean,
  durationMs: Schema.Number,
  /** Missing when the run ended before the task was read; read on its own, so a bad one loses only the header. */
  space: Schema.optionalKey(Schema.Unknown),
  exit: Schema.optionalKey(Schema.String),
  idleSeconds: Schema.optionalKey(Schema.Number),
})
const decodeRan = Schema.decodeUnknownExit(Ran)
const decodeSpace = Schema.decodeUnknownExit(Space)
const decodeStarted = Schema.decodeUnknownExit(Schema.Array(Schema.String))

/** What GeoAgent reads when the script did not run; an environment that is not ready comes with what to do about it. */
const failureMessage = (failure: GeoEngine.Failure) => {
  if (failure.code === "not-ready") return failure.message
  if (failure.code === "invalid-params") return `${failure.message}, so the script did not run.`
  if (failure.code === "initialize-failed")
    return `Earth Engine could not be initialized, so the script did not run: ${failure.message}`
  if (failure.code === "space-failed")
    return `GeoCode could not read its folder of Earth Engine assets, so the script did not run: ${failure.message}`
  if (failure.code === "task-taken")
    return `${failure.message}, so the script did not run. Continue it with "task", or give "new_task" another name.`
  if (failure.code === "task-missing")
    return `${failure.message}, so the script did not run. Start it with "new_task", or check the name.`
  return "Google Earth Engine is not available right now. Tell the user; restarting GeoCode may fix it."
}

const failed = (failure: GeoEngine.Failure) =>
  Effect.logWarning("geerun failed", { code: failure.code, message: failure.message, details: failure.details }).pipe(
    Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure) }))),
  )

/** Whole seconds, or tenths below one. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** An Earth Engine time to the minute, as "2026-10-08 14:05 UTC"; anything else as it is. */
const minute = (time: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(time)
  return match ? `${match[1]} ${match[2]} UTC` : time
}

/** Text the user or Earth Engine wrote, on one line of the header. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim()

/** One asset of the task, with what GeoCode wrote of it when it was saved. */
const assetLine = (asset: typeof Asset.Type) => {
  const facts = [
    asset.type.toLowerCase().replace("_", " "),
    asset.bands?.length ? `bands ${asset.bands.map(flat).join(", ")}` : "",
    asset.saved ? `saved ${minute(asset.saved)}` : "",
  ].filter(Boolean)
  const said = [asset.title, asset.description].flatMap((text) => (text === undefined ? [] : [flat(text)])).join(". ")
  return `- ${asset.name}${facts.length ? ` (${facts.join("; ")})` : ""}${said ? `: ${said}` : ""}`
}

/** What the answer starts with: the task GeoAgent works in, what it holds, and the latest other tasks. */
const header = (task: { readonly name: string; readonly new: boolean }, space: typeof Space.Type) => {
  const held = space.assets.length + space.more
  const opening = task.new
    ? `Task ${task.name} (new): nothing saved yet.`
    : `Task ${task.name}: ${held ? plural(held, "asset") : "nothing saved yet"}.`
  const counted = space.tasks > space.others.length ? ` (${space.tasks} in all, the latest ${space.others.length})` : ""
  const others = space.others.length
    ? [
        `Other tasks in GeoCode${counted}:`,
        ...space.others.map(
          (other) => `- ${other.name} (${plural(other.assets, "asset")}, updated ${minute(other.updated)})`,
        ),
      ]
    : []
  const assets = fitting(space.assets.map(assetLine), [opening, ...others])
  const hidden = space.more + space.assets.length - assets.length
  return [opening, ...assets, ...(hidden ? [`- and ${plural(hidden, "more asset")}`] : []), ...others].join("\n")
}

/** The most of the kernel's bounds on an answer the header takes, leaving the rest to what the script printed. */
const HEADER_LINES = 200
const HEADER_BYTES = ToolOutput.MAX_BYTES / 2

/**
 * The asset lines that fit the header's share of the answer beside its other lines, which GeoEngine keeps short: the
 * other tasks matter more than the last of a long list of assets.
 */
const fitting = (lines: readonly string[], others: readonly string[]) => {
  const size = (line: string) => Buffer.byteLength(line, "utf-8") + 1
  // Room kept for the line counting the assets left out.
  let room = HEADER_BYTES - others.reduce((total, line) => total + size(line), 0) - 64
  const kept: string[] = []
  for (const line of lines) {
    if (kept.length >= HEADER_LINES - others.length - 1 || size(line) > room) break
    kept.push(line)
    room -= size(line)
  }
  return kept
}

/** How the run ended, after what it printed. */
const ending = (ran: typeof Ran.Type) => {
  const after = seconds(ran.durationMs)
  if (ran.outcome === "finished") return `Finished in ${after}.`
  if (ran.outcome === "failed") return `The script failed after ${after}.`
  if (ran.outcome === "idle") {
    const silent = ran.idleSeconds === undefined ? "" : ` for the last ${ran.idleSeconds} s`
    return `Stopped after ${after}:${silent} the script printed nothing and waited for no request to Earth Engine.`
  }
  return `The Python ended${ran.exit === undefined ? "" : ` with ${ran.exit}`} after ${after}, before the script finished.`
}

/** Room left in the kernel's bounds on an answer for the note and the ending around the header and what was printed. */
const RESERVED_LINES = 10
const RESERVED_BYTES = 1024

/**
 * The end of what the script printed, within what is left of the kernel's bounds on an answer. The kernel's own cut
 * keeps the start, which would lose a failing script's traceback and how the run ended.
 */
const lastPart = (text: string, used: { readonly lines: number; readonly bytes: number }) => {
  const lines = text.split("\n")
  const kept: string[] = []
  let room = ToolOutput.MAX_BYTES - RESERVED_BYTES - used.bytes
  for (const line of lines.toReversed()) {
    if (kept.length >= ToolOutput.MAX_LINES - RESERVED_LINES - used.lines) break
    const size = Buffer.byteLength(line, "utf-8") + 1
    if (size > room) {
      // The end of a line too long to keep whole, as long as there is room: it may hold the error.
      if (room > 0) kept.push(Buffer.from(line, "utf-8").subarray(-room).toString("utf-8"))
      return { text: kept.toReversed().join("\n"), cut: true }
    }
    kept.push(line)
    room -= size
  }
  return { text: kept.toReversed().join("\n"), cut: kept.length < lines.length }
}

export const make = (
  permission: Permission.Interface,
  access: FileAccess.Interface,
  location: Location.Interface,
  storage: Context["storage"],
) => ({
  name,
  // On the provider's tool list, as the built-in tools are, rather than inside Code Mode's catalog.
  options: { codemode: false },
  description,
  input: Input,
  execute: (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      if ((input.script === undefined) === (input.path === undefined)) {
        return yield* new ToolFailure({ message: 'Give exactly one of "script" and "path".' })
      }
      if ((input.task === undefined) === (input.new_task === undefined)) {
        return yield* new ToolFailure({
          message: 'Give exactly one of "task", to continue a task, and "new_task", to start one.',
        })
      }
      const taskName = input.new_task ?? input.task ?? ""
      if (!TASK_NAME.test(taskName)) {
        return yield* new ToolFailure({
          message: `"${taskName}" is not a task name: use 1 to 30 letters, digits, "_" or "-", such as taipei-ndvi-20261008.`,
        })
      }
      // The tasks this conversation started: one that has saved nothing has no folder to be known by.
      const key = `geerun/tasks/${context.sessionID}`
      const read = decodeStarted(yield* storage.get(key))
      const started = Exit.isSuccess(read) ? read.value : []
      if (input.new_task !== undefined && started.includes(taskName)) {
        return yield* new ToolFailure({
          message: `The task ${taskName} was already started in this conversation. Continue it with "task", or give "new_task" another name.`,
        })
      }
      const task = { name: taskName, new: input.new_task !== undefined, started: started.includes(taskName) }
      const target = input.path === undefined ? undefined : yield* access.resolve({ path: input.path, kind: "file" })
      const file = target?.absolute
      // Checked before asking, so the user is never asked about a run that cannot start. A file outside the project is
      // left to the run, after the user allows its directory: looking at it first would answer whether it is there.
      const inside = target !== undefined && target.externalDirectory === undefined
      yield* GeoEngine.call("gee.check", { cwd: location.directory, ...(inside ? { file } : {}) }).pipe(
        Effect.catch(failed),
      )
      // As the shell asks about the directories its command names: a file outside the project, by its directory.
      if (target) yield* access.authorizeExternal([target], context)
      // As the shell is asked about: the script can do anything the user can.
      yield* permission.assert({
        action: name,
        resources: ["*"],
        save: ["*"],
        metadata: {
          description: input.description,
          task: task.name,
          ...(file === undefined ? { script: input.script } : { path: file }),
        },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const params = {
        cwd: location.directory,
        task,
        ...(file === undefined ? { script: input.script } : { file }),
      }
      const result = yield* GeoEngine.call("gee.run", params).pipe(Effect.catch(failed))
      const decoded = decodeRan(result)
      if (Exit.isFailure(decoded)) {
        return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(decoded.cause) }))
      }
      const ran = decoded.value
      // Once the run got past the task's checks, which its header says, the task exists in this conversation, whether or
      // not its script worked. Read again: another call in the conversation may have started a task meanwhile.
      if (task.new && ran.space !== undefined) {
        const now = decodeStarted(yield* storage.get(key))
        const known = Exit.isSuccess(now) ? now.value : []
        if (!known.includes(taskName)) yield* storage.set(key, [...known, taskName])
      }
      const space = ran.space === undefined ? undefined : decodeSpace(ran.space)
      if (space && Exit.isFailure(space)) yield* Effect.logWarning("geerun header unreadable", { cause: space.cause })
      const opening = space && Exit.isSuccess(space) ? header(task, space.value) : ""
      const output = lastPart(ran.output.trimEnd(), {
        lines: opening.split("\n").length,
        bytes: Buffer.byteLength(opening, "utf-8"),
      })
      const truncated = ran.truncated || output.cut
      return {
        content: [
          ...(opening ? [opening] : []),
          ...(truncated ? ["(The output was too long; only its end is kept.)"] : []),
          ...(output.text ? [output.text] : truncated ? [] : ["(The script printed nothing.)"]),
          ending(ran),
        ].join("\n\n"),
        // Set, so the kernel does not cut the answer again from its start.
        metadata: { description: input.description, task: task.name, outcome: ran.outcome, truncated },
      }
    }).pipe(
      // As the built-in tools do: a refused permission or a missing session still ends as this tool's failure.
      Effect.mapError((error) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to run the script", error }),
      ),
    ),
})
