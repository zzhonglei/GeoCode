export * as GeeRunTool from "./geerun.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import type { FileAccess } from "../file-access.js"
import type { Location } from "../location.js"
import type { Permission } from "../permission.js"
import { ToolOutput } from "../tool-output.js"
import { GeoEngine } from "./geoengine.js"

export const name = "geerun"

export const description = `Run a Python script that uses Google Earth Engine.

- \`ee\` is imported and initialized with the user's Google Cloud project before the script starts. Do not call ee.Authenticate() or ee.Initialize().
- Give the code as "script", or the path of a .py file as "path". It runs in the session's directory, with the Python configured for Earth Engine.
- What the script prints, and its errors, are all you get back, so print what you need. Bring results from Earth Engine with getInfo() and keep them small: statistics or a few values, not pixels or long lists.
- There is no time limit while the script waits for Earth Engine. A script that prints nothing and waits for no request to Earth Engine for two minutes is stopped.`

export const Input = Schema.Struct({
  script: Schema.optionalKey(Schema.String).annotate({ description: 'The Python code to run. Give this or "path"' }),
  path: Schema.optionalKey(Schema.String).annotate({
    description: 'The .py file to run, absolute or relative to the session\'s directory. Give this or "script"',
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "A short 3-5 word label for this step, in the user's language, displayed to the user",
  }),
})

const Ran = Schema.Struct({
  outcome: Schema.Literals(["finished", "failed", "crashed", "idle"]),
  output: Schema.String,
  truncated: Schema.Boolean,
  durationMs: Schema.Number,
  exit: Schema.optionalKey(Schema.String),
  idleSeconds: Schema.optionalKey(Schema.Number),
})
const decodeRan = Schema.decodeUnknownExit(Ran)

/** What GeoAgent reads when the script did not run; an environment that is not ready comes with what to do about it. */
const failureMessage = (failure: GeoEngine.Failure) => {
  if (failure.code === "not-ready") return failure.message
  if (failure.code === "invalid-params") return `${failure.message}, so the script did not run.`
  if (failure.code === "initialize-failed")
    return `Earth Engine could not be initialized, so the script did not run: ${failure.message}`
  return "Google Earth Engine is not available right now. Tell the user; restarting GeoCode may fix it."
}

const failed = (failure: GeoEngine.Failure) =>
  Effect.logWarning("geerun failed", { code: failure.code, message: failure.message, details: failure.details }).pipe(
    Effect.andThen(Effect.fail(new ToolFailure({ message: failureMessage(failure) }))),
  )

/** Whole seconds, or tenths below one. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`

/** GeoAgent's label for the step, left out when it wrote none: metadata is stored as JSON, which has no undefined. */
const labelOf = (input: { readonly description?: string }) =>
  input.description === undefined ? {} : { description: input.description }

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

/** Room left in the kernel's bounds on an answer for the note and the ending around what the script printed. */
const RESERVED_LINES = 10
const RESERVED_BYTES = 1024

/**
 * The end of what the script printed, within the kernel's bounds on an answer. The kernel's own cut keeps the start,
 * which would lose a failing script's traceback and how the run ended.
 */
const lastPart = (text: string) => {
  const lines = text.split("\n")
  const kept: string[] = []
  let room = ToolOutput.MAX_BYTES - RESERVED_BYTES
  for (const line of lines.toReversed()) {
    if (kept.length >= ToolOutput.MAX_LINES - RESERVED_LINES) break
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

export const make = (permission: Permission.Interface, access: FileAccess.Interface, location: Location.Interface) => ({
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
        metadata: { ...labelOf(input), ...(file === undefined ? { script: input.script } : { path: file }) },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const params =
        file === undefined ? { script: input.script, cwd: location.directory } : { file, cwd: location.directory }
      const result = yield* GeoEngine.call("gee.run", params).pipe(Effect.catch(failed))
      const decoded = decodeRan(result)
      if (Exit.isFailure(decoded)) {
        return yield* failed(new GeoEngine.Failure({ code: "unreadable", message: String(decoded.cause) }))
      }
      const ran = decoded.value
      const output = lastPart(ran.output.trimEnd())
      const truncated = ran.truncated || output.cut
      return {
        content: [
          ...(truncated ? ["(The output was too long; only its end is kept.)"] : []),
          output.text || "(The script printed nothing.)",
          ending(ran),
        ].join("\n\n"),
        // Set, so the kernel does not cut the answer again from its start.
        metadata: { ...labelOf(input), outcome: ran.outcome, truncated },
      }
    }).pipe(
      // As the built-in tools do: a refused permission or a missing session still ends as this tool's failure.
      Effect.mapError((error) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to run the script", error }),
      ),
    ),
})
