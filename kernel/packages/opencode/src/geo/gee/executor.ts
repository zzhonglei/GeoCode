export * as GeeExecutor from "./executor"

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Duration, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { GeoRuntime } from "../runtime"
import { GEOCODE_PY } from "./scripts.generated"
import type { Environment } from "./types"

/* --- GeoCode: GEE script execution (docs/GEOKERNEL.md §5.9).
 *
 * Takes a verified environment from the gate rather than looking a status up (§9.1), and returns structured facts:
 * the script's own output went to `onChunk` as it arrived, and the agent-facing text is the tool layer's to
 * compose (§9.1 第二条硬性形态). --- */

/**
 * Idle rather than total (§8.4): one remote call legitimately runs for hours, so silence is the only signal left —
 * which works only because the script must wrap long operations in the library's heartbeat (§5.9 心跳契约).
 */
export const IDLE_FLOOR_SECONDS = 60
export const IDLE_DEFAULT_SECONDS = 60

/** `geocode.py`'s `heartbeat(interval=30)`; the floor has to stay above it or a compliant script is stopped. */
export const HEARTBEAT_INTERVAL_SECONDS = 30

export interface Options {
  /** Inline source. Exactly one of this and `scriptPath` — the tool layer refuses both, and `scriptPath` wins here. */
  readonly script?: string
  readonly scriptPath?: string
  readonly onChunk: (chunk: string) => Effect.Effect<void>
  /** Idle limit in seconds, clamped up to the floor. §8.4 fixes this tier, so no tool exposes it. */
  readonly idleSeconds?: number
  readonly abort?: AbortSignal
  readonly cwd?: string
}

export interface Outcome {
  readonly result: GeoRuntime.Result
  /** The environment the run actually used, for the caller's header. */
  readonly environment: Environment
  readonly mode: "inline" | "file"
}

/** The directory holding the runtime library, created on first use. */
export function ensureLibrary(
  directory: string = path.join(Global.Path.cache, "geo", "gee-runtime"),
  content: string = GEOCODE_PY,
): string {
  // The DIRECTORY carries the hash: the module has to import as `geocode`, so its filename is fixed and the hash
  // lives one level up. A library change lands in a new directory; an existing one already holds this content.
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  const home = path.join(directory, hash)
  const module = path.join(home, "geocode.py")
  if (!existsSync(module)) {
    mkdirSync(home, { recursive: true })
    const staging = path.join(home, `geocode.${process.pid}.tmp`)
    writeFileSync(staging, content, "utf8")
    try {
      renameSync(staging, module)
    } catch (error) {
      // Windows refuses a rename onto a path another process just created; the path is content-addressed, so a
      // target that exists now holds exactly these bytes.
      if (!existsSync(module)) throw error
    }
  }
  return home
}

/** The injection (§5.9 注入内容): route, project, library path, fault handler, encoding — none of it a script's job. */
export function environmentFor(environment: Environment, libraryHome: string): Record<string, string> {
  const separator = process.platform === "win32" ? ";" : ":"
  const inherited = process.env.PYTHONPATH
  return {
    ...environment.env,
    GEE_PROJECT: environment.project,
    PYTHONPATH: inherited ? `${libraryHome}${separator}${inherited}` : libraryHome,
    // The env-var form, because the script is the agent's to write: a native crash would otherwise leave no stack.
    PYTHONFAULTHANDLER: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "UTF-8",
  }
}

export function run(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: Options,
): Effect.Effect<Outcome, Error> {
  return Effect.gen(function* () {
    const home = yield* Effect.try({
      try: () => ensureLibrary(),
      catch: (error) =>
        new Error(
          `could not write the GEE runtime library to the cache: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })

    const mode: "inline" | "file" = options.scriptPath ? "file" : "inline"
    const args = options.scriptPath ? [options.scriptPath] : ["-c", options.script ?? ""]
    const idle = Math.max(IDLE_FLOOR_SECONDS, options.idleSeconds ?? IDLE_DEFAULT_SECONDS)

    const result = yield* runtime.run({
      command: environment.python,
      args,
      env: environmentFor(environment, home),
      cwd: options.cwd,
      delivery: { mode: "incremental", onChunk: options.onChunk },
      clocks: { idle: Duration.seconds(idle) },
      abort: options.abort,
      label: "gee:run",
    })

    return { result, environment, mode }
  })
}
