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
 * Takes a VERIFIED environment from the gate and never looks a status up for
 * itself (§9.1), and returns the script's own output alongside the facts
 * about the run — assembled text is the tool layer's business, not ours
 * (§9.1 第二条硬性形态). --- */

/**
 * The idle-clock floor and default, in seconds.
 *
 * An IDLE clock, not a total one, and that choice is half of a contract: a
 * GEE script legitimately spends hours inside one remote call, so no total
 * budget could be both generous enough to be safe and small enough to be
 * useful. The other half lives in the runtime library — long operations wrap
 * themselves in a heartbeat, which is what turns "still working" into output
 * this clock can see. A script that does not heartbeat WILL be stopped; that
 * is not a bug to work around but the premise the library is built on, and it
 * has to reach the agent through the tool description (§5.9 心跳契约).
 */
export const IDLE_FLOOR_SECONDS = 30
export const IDLE_DEFAULT_SECONDS = 60

export interface Options {
  /** Inline source, for a one-off query. Exactly one of this and `scriptPath`. */
  readonly script?: string
  /** A file to run, for work worth keeping. Exactly one of this and `script`. */
  readonly scriptPath?: string
  readonly onChunk: (chunk: string) => Effect.Effect<void>
  /** Idle limit in seconds — the §8.4 caller-given tier. Clamped to the floor. */
  readonly idleSeconds?: number
  readonly abort?: AbortSignal
  readonly cwd?: string
}

/**
 * What a run produced.
 *
 * Deliberately not a rendered string: the streaming callback already carried
 * the script's own output to the frontend, and the agent-facing text — the
 * environment header, the termination banner, the elapsed footer — is
 * composed by the tool layer from these facts. Merging them here would force
 * the frontend to take the header back out by string match (§9.1).
 */
export interface Outcome {
  readonly result: GeoRuntime.Result
  /** The environment the run actually used, for the caller's header. */
  readonly environment: Environment
  /** Which form ran, since the two are surfaced differently. */
  readonly mode: "inline" | "file"
}

/** The directory holding the runtime library, created on first use. */
export function ensureLibrary(
  directory: string = path.join(Global.Path.cache, "geo", "gee-runtime"),
  content: string = GEOCODE_PY,
): string {
  // Content-hashed DIRECTORY rather than file: the module has to be importable
  // as `geocode`, so its filename is fixed and the hash has to live one level
  // up. A library change lands in a new directory, and an existing one is by
  // construction the right content.
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
      // Same Windows rename contention as the QGIS reader: the target is
      // content-addressed, so if it exists now someone else wrote exactly this.
      if (!existsSync(module)) throw error
    }
  }
  return home
}

/**
 * The environment a script runs in (§5.9 注入内容).
 *
 * Six things, and each is here because a script that had to arrange it for
 * itself would get it wrong: the route so remote traffic follows what Net
 * resolved, the project so no script hardcodes it, the library path so the
 * import works, the fault handler because we cannot insert a line into a
 * script an agent wrote, and the encoding pair so non-English output is not
 * mojibake on the way out.
 */
export function environmentFor(environment: Environment, libraryHome: string): Record<string, string> {
  const separator = process.platform === "win32" ? ";" : ":"
  const inherited = process.env.PYTHONPATH
  return {
    ...environment.env,
    GEE_PROJECT: environment.project,
    PYTHONPATH: inherited ? `${libraryHome}${separator}${inherited}` : libraryHome,
    // The env-var form of enabling the fault handler, which is the only form
    // available to us: the script is the agent's to write, so a native crash
    // inside a C extension would otherwise produce no stack at all.
    PYTHONFAULTHANDLER: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "UTF-8",
  }
}

/** Run a script in a verified environment. */
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
