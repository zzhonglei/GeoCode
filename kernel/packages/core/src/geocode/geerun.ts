export * as GeeRunTool from "./geerun.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Identifier } from "@opencode/schema/identifier"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit, Schema } from "effect"
import type { Bus } from "../bus.js"
import type { FileAccess } from "../file-access.js"
import type { Job } from "../job.js"
import type { Location } from "../location.js"
import type { Permission } from "../permission.js"
import type { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { ToolOutput } from "../tool-output.js"
import { GeoEngine } from "./geoengine.js"
import type { GeeRunJob } from "./geerun-job.js"
import DESCRIPTION from "./geerun.txt"

export const name = "geerun"

export const description = DESCRIPTION

export const Input = Schema.Struct({
  task: Schema.optionalKey(Schema.String).annotate({
    description: 'ID of an existing task to continue. Use this or "new_task", not both.',
  }),
  new_task: Schema.optionalKey(Schema.String).annotate({
    description:
      'ID of a new task to create, from its purpose and today\'s date, such as taipei-ndvi-20261008 (letters, digits, "_" or "-", at most 30). Use this or "task", not both.',
  }),
  script: Schema.optionalKey(Schema.String).annotate({
    description: 'Python code to run. Use this or "path", not both.',
  }),
  path: Schema.optionalKey(Schema.String).annotate({
    description:
      'Path to a .py file to run, absolute or relative to the session\'s directory. Use this or "script", not both.',
  }),
  description: Schema.String.annotate({
    description: "Short label for this run, 3-5 words in the user's language, shown to the user",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the script in the background and return once it starts (useful for exports and long computations). You will be notified with its answer when it ends. DO NOT sleep or poll for it.",
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
  python: Schema.Struct({
    path: Schema.String,
    version: Schema.String,
    packages: Schema.Record(Schema.String, Schema.String),
  }),
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
    return `${failure.message}, so the script did not run. Continue it with "task", or give "new_task" another ID.`
  if (failure.code === "task-missing")
    return `${failure.message}, so the script did not run. Start it with "new_task", or check the ID.`
  if (failure.code === "task-busy")
    return `${failure.message}, perhaps in another conversation, so the script did not run. Run it again after that call ends.`
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

/** The Python the script ran in, which GeoAgent can use for its own work and look after, by its path. */
const pythonLine = (python: (typeof Ran.Type)["python"]) => {
  const packages = Object.entries(python.packages).map(([name, version]) => `${name} ${version}`)
  return `Python ${python.version} at ${python.path}, with ${packages.join(", ")}.`
}

/**
 * What the answer starts with: the Python, then the task GeoAgent works in, what it holds, and the latest other tasks,
 * all within the header's share of the kernel's bounds.
 */
const header = (python: string, task: { readonly name: string; readonly new: boolean }, space: typeof Space.Type) => {
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
  const assets = fitting(space.assets.map(assetLine), [python, opening, ...others])
  const hidden = space.more + space.assets.length - assets.length
  return [python, opening, ...assets, ...(hidden ? [`- and ${plural(hidden, "more asset")}`] : []), ...others].join(
    "\n",
  )
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

/** What one of GeoCode's functions is doing; no text once none is doing anything. */
const Status = Schema.Struct({
  seq: Schema.Number,
  text: Schema.NullOr(Schema.String),
  progress: Schema.optionalKey(Schema.Number),
})
type Status = typeof Status.Type

/**
 * What GeoEngine tells of a run as it goes: that the script itself began, past the lock and the task's checks; how
 * long the oldest request has waited for Earth Engine; a function's status; what the script printed.
 */
const decodeProgress = Schema.decodeUnknownExit(
  Schema.Union([
    Schema.Struct({ begun: Schema.Literal(true) }),
    Schema.Struct({ waiting: Schema.Number }),
    Schema.Struct({ status: Status }),
    Schema.Struct({ output: Schema.String }),
  ]),
)

/** The latest statuses the tool row is sent: enough to fill in those it missed between two updates. */
const SHOWN_STATUSES = 20
/** The end of what the script printed that the tool row is sent. */
const LOG_CHARS = 32 * 1024
/** How often, at most, the tool row is told: a script may print a line at a time. */
const SHOW_MS = 250
/** GeoEngine tells of a wait every second while it lasts: past this without word, the wait is over. */
const WAIT_MS = 1500
/** How long a wait lasts before the row says so: a shorter one would only flash by. */
const WAIT_SHOWN_MS = 1000

type Recovery = Extract<Job.Recovery, { kind: "geerun" }>

const backgroundAnswer = (task: string) =>
  `Task ${task} is running in the background. You will be notified with its answer when the run ends. DO NOT sleep, poll, or run task ${task} again before then. Work on something else, or tell the user what is running and end your response.`

const RESTARTED =
  "The run was stopped because GeoCode restarted. Assets its exports already saved, or still save, stay in the task; run the script again to finish it."

/** What a background run's notification says: the answer it ended with, as a shell's says what the command printed. */
export const said = (
  result: Pick<Job.Background, "output" | "error"> & { readonly status: Exclude<Job.Status, "running"> },
) =>
  result.status === "completed"
    ? (result.output ?? "")
    : result.status === "error"
      ? (result.error ?? "The run failed.")
      : "The run was cancelled."

export const notification = (
  recovery: Recovery,
  state: Exclude<Job.Status, "running">,
  text: string,
  final: Record<string, unknown> = {},
) => ({
  sessionID: recovery.sessionID,
  description: recovery.description,
  text: `<geerun task="${recovery.task}" state="${state}" description="${recovery.description}">\n${text}\n</geerun>`,
  // For the tool row of the call, which a run in the background left running: what it shows once the run ends.
  metadata: { ...final, source: name, task: recovery.task, state, callID: recovery.callID },
})

/** After a restart, as the kernel does for a shell: tells of a background run, which a restart stopped if unfinished. */
export const recover = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  background: Job.Background,
  recovery: Recovery,
) {
  const state = background.status === "running" ? "cancelled" : background.status
  yield* sessions
    .synthetic({
      id: background.notificationID,
      ...notification(
        recovery,
        state,
        background.status === "running" ? RESTARTED : said({ ...background, status: state }),
      ),
      // As a shell's: a restart's notice does not wake a conversation that is idle.
      resume: false,
    })
    .pipe(
      Effect.catchTag("Session.NotFoundError", () => Effect.void),
      Effect.orDie,
    )
  yield* jobs.completeBackground(background.notificationID)
})

export const make = (
  permission: Permission.Interface,
  access: FileAccess.Interface,
  location: Location.Interface,
  storage: Context["storage"],
  jobs: Job.Interface,
  bus: Pick<Bus.Interface, "publish">,
  runs: GeeRunJob.Interface,
) => {
  /** The answer a run gave, from the script's output and the task GeoEngine read before it. */
  const answer = Effect.fnUntraced(function* (
    result: unknown,
    task: { readonly name: string; readonly new: boolean },
    key: string,
    label: string,
    since: number,
  ) {
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
      if (!known.includes(task.name)) yield* storage.set(key, [...known, task.name])
    }
    const space = ran.space === undefined ? undefined : decodeSpace(ran.space)
    if (space && Exit.isFailure(space)) yield* Effect.logWarning("geerun header unreadable", { cause: space.cause })
    const python = pythonLine(ran.python)
    const opening = space && Exit.isSuccess(space) ? header(python, task, space.value) : python
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
      // Set, so the kernel does not cut the answer again from its start. The tool row shows, once the run ends, how
      // long it took and what the script printed, as it did while the run went on.
      metadata: {
        description: label,
        task: task.name,
        outcome: ran.outcome,
        truncated,
        started: since,
        log: ran.output.slice(-LOG_CHARS),
      },
    }
  })

  return {
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
            message: `The task ${taskName} was already started in this conversation. Continue it with "task", or give "new_task" another ID.`,
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
        // As the shell tool runs a command: a job of the kernel's, waited for unless it is or is moved to the background.
        const begun = yield* Deferred.make<void>()
        const settled = yield* Deferred.make<Effect.Success<ReturnType<typeof answer>>, ToolFailure>()

        // The tool row counts the run from here, after the user's answer, as it does a QGIS run.
        const since = Date.now()
        const statuses: Status[] = []
        let log = ""
        // While requests wait for Earth Engine, one after another or together, since the first began: the row says so
        // once it has lasted, when no function tells what it does. The script beginning or a function's status ends the
        // run of requests, so a wait from before does not count toward the next.
        let waiting: { readonly since: number; readonly heard: number; readonly long: boolean } | undefined
        // Once the script itself began: before, the row says it is starting.
        let scriptBegan = false
        let shown = 0
        let changed = false
        // Once the call has returned, as a run in the background does, the kernel takes no more progress for it: the
        // row, which the answer left running, is told on the bus itself, as the kernel tells it of a running call.
        let returned = false
        const state = () => ({
          description: input.description,
          task: task.name,
          started: since,
          statuses: [...statuses],
          log,
          ...(waiting?.long ? { waitingSince: waiting.since } : {}),
          ...(scriptBegan ? { begun: true } : {}),
          ...(returned ? { status: "running" } : {}),
        })
        const show = Effect.suspend(() => {
          changed = false
          shown = performance.now()
          const told = returned
            ? bus.publish(SessionEvent.Tool.Progress, {
                sessionID: context.sessionID,
                assistantMessageID: context.messageID,
                id: context.id,
                metadata: state(),
              })
            : context.progress(state())
          // What the row shows is not worth the run: a row that cannot be told only goes without.
          return told.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) => Effect.logWarning("geerun progress not shown", { cause })),
          )
        })
        const heed = (data: unknown) =>
          Effect.suspend(() => {
            const decoded = decodeProgress(data)
            if (Exit.isFailure(decoded)) return Effect.void
            const told = decoded.value
            if (!("waiting" in told || "output" in told)) waiting = undefined
            if ("begun" in told) scriptBegan = true
            else if ("waiting" in told) {
              const now = Date.now()
              const start = waiting?.since ?? now - told.waiting * 1000
              const long = waiting?.long === true
              waiting = { since: start, heard: now, long: long || now - start >= WAIT_SHOWN_MS }
              // A beat that changes nothing the row shows is not worth sending it the whole state again.
              if (waiting.long === long) return Effect.void
            } else if ("status" in told) {
              statuses.push(told.status)
              if (statuses.length > SHOWN_STATUSES) statuses.shift()
            } else log = (log + told.output).slice(-LOG_CHARS)
            const tell = performance.now() - shown >= SHOW_MS ? show : Effect.sync(() => void (changed = true))
            return "begun" in told ? Deferred.succeed(begun, undefined).pipe(Effect.andThen(tell)) : tell
          })
        // What came within the last moments, once they pass; and the end of a wait, which GeoEngine does not tell.
        const flush = Effect.forever(
          Effect.sleep(SHOW_MS).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (waiting && Date.now() - waiting.heard > WAIT_MS) {
                  changed ||= waiting.long
                  waiting = undefined
                }
                return changed && performance.now() - shown >= SHOW_MS ? show : Effect.void
              }),
            ),
          ),
        )

        yield* show
        const run = Effect.raceFirst(GeoEngine.call("gee.run", params, heed), flush).pipe(
          // What came within the last moment before the end, which the flush no longer sends.
          Effect.ensuring(Effect.suspend(() => (changed ? show : Effect.void))),
          // GeoEngine ends a run itself only as the app quits, often before the kernel: stopped, not failed, so that a
          // run in the background is told of after the restart.
          Effect.catchIf(
            (failure) => failure.code === "cancelled",
            () => Effect.interrupt,
          ),
          Effect.catch(failed),
          Effect.flatMap((result) => answer(result, task, key, input.description, since)),
          Effect.onExit((exit) => Deferred.done(settled, exit)),
          Effect.map((answered) => answered.content),
        )
        const recovery = {
          kind: "geerun" as const,
          sessionID: context.sessionID,
          task: task.name,
          description: input.description,
          callID: context.id,
        }
        const job = yield* jobs.start({
          // A fresh ID: one of the task's name would join a run of the task under way, past GeoEngine's lock.
          id: "job_" + Identifier.ascending(),
          type: name,
          title: input.description,
          metadata: { sessionID: context.sessionID, task: task.name },
          recovery,
          run,
        })
        const block = jobs.block({ id: job.id, sessionID: context.sessionID })
        // In the background once the script begins: a run that cannot start is told now, as a shell that cannot spawn.
        const waited = yield* (
          input.background === true
            ? Effect.raceFirst(block, Deferred.await(begun).pipe(Effect.as({ type: "begun" as const })))
            : block
        ).pipe(Effect.onInterrupt(() => jobs.cancel(job.id).pipe(Effect.ignore)))
        if (waited?.type === "begun" || waited?.type === "backgrounded") {
          returned = true
          // Settled before the job ends. A run that failed outright gave no answer: the row keeps what it last showed.
          const final = Deferred.await(settled).pipe(
            Effect.exit,
            Effect.map(
              (exit): Record<string, unknown> =>
                Exit.isSuccess(exit) ? exit.value.metadata : { description: input.description, started: since, log },
            ),
          )
          // Whole, or a stop just as the script begins would leave the run with no one to tell of it.
          yield* Effect.uninterruptible(runs.background(job.id, recovery, final))
          return { content: backgroundAnswer(task.name), metadata: state() }
        }
        if (waited?.info.status === "cancelled") return yield* new ToolFailure({ message: "The run was cancelled." })
        return yield* Deferred.await(settled)
      }).pipe(
        // As the built-in tools do: a refused permission or a missing session still ends as this tool's failure.
        Effect.mapError((error) =>
          error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to run the script", error }),
        ),
      ),
  }
}
