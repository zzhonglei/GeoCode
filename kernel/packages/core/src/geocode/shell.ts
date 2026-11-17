export * as GeoShell from "./shell.js"

import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { Effect, Exit, Schema } from "effect"
import { GeoEngine } from "./geoengine.js"

/**
 * What a shell needs to run GeoCode's working Python environment, as GeoEngine's `python.activation` gives it (`shell`
 * in geoengine/src/python/index.ts): folders to put first in PATH, variables to set, variables to set only where the
 * user has none, and variables to take away. null until the environment is ready.
 */
const Activation = Schema.NullOr(
  Schema.Struct({
    path: Schema.Array(Schema.String),
    set: Schema.Record(Schema.String, Schema.String),
    fallback: Schema.Record(Schema.String, Schema.String),
    remove: Schema.Array(Schema.String),
  }),
)
type Activation = NonNullable<typeof Activation.Type>

const decode = Schema.decodeUnknownExit(Activation)

/** GeoEngine answers at once; a shell command waits no longer than this for it. */
const ASK_TIMEOUT = "5 seconds"

/**
 * The hook that runs each command of GeoAgent's shell, and of the user's in the chat, with GeoCode's Python environment
 * activated: its python, pip and GDAL commands first, with the environment's own variables. Before the environment is
 * ready, or where GeoEngine cannot be asked, a command runs as the user's. Asked again until GeoEngine has it, then kept:
 * the environment stays where it is while the app runs. Relies on Shell.create spawning the command with the very env
 * its create.before hooks changed: should it copy env after them, every command would run unactivated without a word.
 */
export const make = (platform: NodeJS.Platform = process.platform) => {
  let found: Activation | undefined
  return (invocation: ShellCreateBefore) =>
    Effect.gen(function* () {
      if (!found) found = (yield* ask) ?? undefined
      if (found) apply(invocation.env, found, platform)
    })
}

const ask = GeoEngine.call("python.activation", {}).pipe(
  Effect.timeoutOrElse({
    duration: ASK_TIMEOUT,
    orElse: () => Effect.fail(new GeoEngine.Failure({ code: "timeout", message: "GeoEngine did not answer" })),
  }),
  Effect.flatMap((result) => {
    const decoded = decode(result)
    if (Exit.isSuccess(decoded)) return Effect.succeed(decoded.value)
    return Effect.fail(new GeoEngine.Failure({ code: "invalid", message: "python.activation answered otherwise" }))
  }),
  Effect.catch((failure) =>
    Effect.logWarning("GeoAgent's shell runs without GeoCode's Python environment", failure.message).pipe(
      Effect.as(null),
    ),
  ),
)

/**
 * Activates `env` in place. Windows reads a variable's name in any case, and a copy of its environment can hold `Path`
 * or a lowercase name the user set, so there every spelling of a name is replaced together.
 */
export function apply(env: Record<string, string | undefined>, activation: Activation, platform: NodeJS.Platform) {
  const spellings = (name: string) =>
    platform === "win32"
      ? Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase())
      : Object.keys(env).filter((key) => key === name)
  const read = (name: string) =>
    spellings(name)
      .map((key) => env[key])
      .find((value) => value)
  const write = (name: string, value: string) => {
    for (const key of spellings(name)) delete env[key]
    env[name] = value
  }

  for (const name of activation.remove) for (const key of spellings(name)) delete env[key]
  for (const [name, value] of Object.entries(activation.set)) write(name, value)
  for (const [name, value] of Object.entries(activation.fallback)) if (!read(name)) write(name, value)
  const separator = platform === "win32" ? ";" : ":"
  const rest = (read("PATH") ?? "").split(separator).filter((folder) => folder && !activation.path.includes(folder))
  write("PATH", [...activation.path, ...rest].join(separator))
}
