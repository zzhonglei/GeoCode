export * as Environment from "./index.ts"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Data, type Duration, Effect, Exit, Fiber, Schedule, Schema } from "effect"
import type { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"

const DOMAIN = "python"

const WINDOWS = process.platform === "win32"

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"

/** The system's own tar: bsdtar, which macOS has and Windows has had since Windows 10 version 1803. */
const TAR = WINDOWS ? path.join(SYSTEM_ROOT, "System32", "tar.exe") : "/usr/bin/tar"

/** A slow disk, or a scan of each new file, can take minutes over the many small files. */
const UNPACK_TIMEOUT = "20 minutes"

const CREATE_TIMEOUT = "2 minutes"

const WARM_TIMEOUT = "10 minutes"

const SHOW_EVERY = "250 millis"

/** Characters kept of what a failed command printed, the latest. */
const OUTPUT_TAIL = 16 * 1024

/** The name of a folder being unpacked into, followed by mkdtemp's random part. */
const UNPACKING = ".unpack-"

/**
 * Imported once the environment is ready (docs/PYTHON.md, section 6). matplotlib is left out: importing it writes in the
 * user's home.
 */
const WARM = ["numpy", "pandas", "scipy.linalg", "shapely", "pyproj", "pyogrio", "rasterio", "netCDF4"]

/** Given to a Python of GeoCode's whatever the case of their names, with HOME (docs/PYTHON.md, section 6.1). */
const NETWORK = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
])

/**
 * Given with `inherit: false`. On Windows Node copies the system variables a process needs from the engine's
 * environment when they are missing, PATH among them, so the system's own PATH takes the place of the user's.
 */
const environment = () => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && NETWORK.has(name.toUpperCase())) result[name] = value
  }
  // Without it Python finds the account's home from the system, past a sandbox that moved it.
  if (process.env.HOME !== undefined) result.HOME = process.env.HOME
  if (WINDOWS) result.PATH = [path.join(SYSTEM_ROOT, "System32"), SYSTEM_ROOT].join(";")
  return result
}

/** Both from the main process. */
export interface Places {
  /** The folder holding what scripts/stage-python.sh staged: python.tar.gz and python.json. */
  readonly bundle: string
  /** GeoCode's data directory, whose python folder holds the environment. */
  readonly data: string
}

/** What scripts/stage-python.sh writes beside the archive. */
const Bundle = Schema.Struct({ id: Schema.String, python: Schema.String, entries: Schema.Number })

const Marker = Schema.Struct({ id: Schema.String })

const decodeBundle = Schema.decodeUnknownExit(Schema.fromJsonString(Bundle))
const decodeMarker = Schema.decodeUnknownExit(Schema.fromJsonString(Marker))

type Step = "bundle" | "unpack" | "environment"

export interface Diagnostics {
  readonly step: Step
  readonly message: string
  /** What the command printed, when one failed. */
  readonly output?: string
}

export type State =
  | { readonly status: "checking" }
  | {
      readonly status: "preparing"
      readonly step: "unpacking" | "creating"
      /** The files unpacked so far, of all of them. */
      readonly done?: number
      readonly total?: number
    }
  /** `python` is the working environment's interpreter, which GeoAgent and the runs use. */
  | { readonly status: "ready"; readonly version: string; readonly python: string }
  | { readonly status: "failed"; readonly diagnostics: Diagnostics }

class Failed extends Data.TaggedError("GeoEnginePythonFailed")<Diagnostics> {}

/** The folders and interpreters under the data directory (docs/PYTHON.md, section 3). */
export const layout = (data: string) => {
  const root = path.join(data, "python")
  const base = path.join(root, "base")
  const env = path.join(root, "envs", "default")
  return {
    root,
    base,
    env,
    marker: path.join(root, "base.json"),
    basePython: WINDOWS ? path.join(base, "python.exe") : path.join(base, "bin", "python3"),
    envPython: WINDOWS ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python"),
  }
}

/**
 * Prepares GeoCode's Python environment in the background as the engine starts (docs/PYTHON.md, section 6): unpacks
 * the bundled one when the data directory has another or none, and makes the working environment when it is missing.
 * A failure is left for the next start to try again.
 */
export const capability = (places: Places): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const runtime = yield* Runtime.Service
    const writer = yield* status.register<State>(DOMAIN, { status: "checking" })
    // One round: the environment is prepared once per start.
    const token = yield* writer.claim()
    const where = layout(places.data)

    // UTF-8 as a flag: isolated, Python ignores PYTHONUTF8.
    const python = (command: string, args: readonly string[], total: Duration.Input) =>
      runtime.run({
        command,
        args: ["-I", "-X", "utf8", ...args],
        env: environment(),
        inherit: false,
        delivery: { mode: "collect" },
        clocks: { total },
      })

    const unpack = (bundle: typeof Bundle.Type) =>
      Effect.gen(function* () {
        yield* attempt("unpack", () => fsp.mkdir(where.root, { recursive: true }))
        const into = yield* attempt("unpack", () => fsp.mkdtemp(path.join(where.root, UNPACKING)))
        // tar names each file it writes on a line of its own.
        let done = 0
        let printed = ""
        const show = Effect.suspend(() =>
          writer.commit(token, {
            status: "preparing",
            step: "unpacking",
            done,
            total: bundle.entries,
          }),
        )
        yield* Effect.gen(function* () {
          yield* show
          const showing = yield* Effect.forkChild(Effect.repeat(show, Schedule.spaced(SHOW_EVERY)))
          const result = yield* runtime
            .run({
              command: TAR,
              args: ["-xvzf", path.join(places.bundle, "python.tar.gz"), "-C", into],
              delivery: {
                mode: "incremental",
                source: "all",
                onChunk: (chunk) => {
                  done += chunk.split("\n").length - 1
                  printed = (printed + chunk).slice(-OUTPUT_TAIL)
                },
              },
              clocks: { total: UNPACK_TIMEOUT },
            })
            .pipe(
              Effect.ensuring(Fiber.interrupt(showing)),
              Effect.mapError((error) => new Failed({ step: "unpack", message: error.message })),
            )
          yield* expect("unpack", "tar", result, printed)

          // The marker is written last: a start that finds it stale, or the interpreter missing, unpacks again.
          yield* attempt("unpack", async () => {
            const replaced = path.join(into, "replaced")
            if (fs.existsSync(where.base)) await fsp.rename(where.base, replaced)
            await fsp.rename(path.join(into, "python"), where.base).catch(async (error) => {
              // The environment in place stays, rather than going with the folder.
              if (fs.existsSync(replaced)) await fsp.rename(replaced, where.base)
              throw error
            })
            // Made from the environment just replaced.
            await fsp.rm(where.env, { recursive: true, force: true })
            await fsp.writeFile(where.marker, JSON.stringify({ id: bundle.id }) + "\n")
          })
          // Taking the replaced environment along, or what a failed unpacking wrote.
        }).pipe(Effect.ensuring(remove(into)))
      })

    const create = () =>
      Effect.gen(function* () {
        yield* writer.commit(token, { status: "preparing", step: "creating" })
        yield* attempt("environment", () => fsp.rm(where.env, { recursive: true, force: true }))
        // Without pip of its own: the base environment's, which it sees, installs into it.
        const args = ["-m", "venv", "--system-site-packages", "--without-pip", where.env]
        const result = yield* python(where.basePython, args, CREATE_TIMEOUT).pipe(
          Effect.mapError((error) => new Failed({ step: "environment", message: error.message })),
        )
        yield* expect("environment", "venv", result, result.stderr || result.stdout)
      })

    const warm = python(where.envPython, ["-c", WARM.map((name) => `import ${name}`).join("; ")], WARM_TIMEOUT).pipe(
      Effect.flatMap((result) =>
        result.reason === "exit" && result.code === 0
          ? Effect.void
          : Effect.logWarning("GeoEngine could not warm up the Python environment", result.stderr.slice(-OUTPUT_TAIL)),
      ),
      Effect.catch((error) => Effect.logWarning("GeoEngine could not warm up the Python environment", error.message)),
    )

    const prepare = Effect.gen(function* () {
      const text = yield* attempt("bundle", () => fsp.readFile(path.join(places.bundle, "python.json"), "utf-8"))
      const decoded = decodeBundle(text)
      if (Exit.isFailure(decoded)) {
        return yield* new Failed({
          step: "bundle",
          message: "python.json is not as stage-python.sh writes it",
          output: text,
        })
      }
      const bundle = decoded.value
      // What an unpacking cut short left behind.
      const left = yield* Effect.promise(() => fsp.readdir(where.root).catch(() => [] as string[]))
      for (const name of left) if (name.startsWith(UNPACKING)) yield* remove(path.join(where.root, name))

      if (!(yield* Effect.promise(() => installed(where, bundle.id)))) yield* unpack(bundle)
      if (!fs.existsSync(where.envPython)) yield* create()
      yield* writer.commit(token, { status: "ready", version: bundle.python, python: where.envPython })
      yield* warm
    }).pipe(
      Effect.catchTag("GeoEnginePythonFailed", (failed) =>
        writer.commit(token, {
          status: "failed",
          diagnostics: {
            step: failed.step,
            message: failed.message,
            ...(failed.output ? { output: failed.output } : {}),
          },
        }),
      ),
    )

    yield* Effect.forkScoped(prepare)
    return { domain: DOMAIN, methods: {} }
  })

function attempt<A>(step: Step, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => new Failed({ step, message: error instanceof Error ? error.message : String(error) }),
  })
}

/** Fails unless the command ran to a clean exit. */
function expect(step: Step, what: string, result: Runtime.Result, output: string) {
  if (result.reason === "exit" && result.code === 0) return Effect.void
  const ended =
    result.reason === "timeout"
      ? `${what} did not finish in time`
      : result.signal
        ? `${what} was ended by ${result.signal}`
        : `${what} exited with code ${result.code}`
  const tail = output.slice(-OUTPUT_TAIL)
  return Effect.fail(new Failed({ step, message: ended, ...(tail ? { output: tail } : {}) }))
}

/** A leftover is only space taken: one that cannot go now is tried again at the next start. */
function remove(target: string) {
  return Effect.promise(() => fsp.rm(target, { recursive: true, force: true })).pipe(
    Effect.catchCause((cause) => Effect.logWarning(`GeoEngine could not remove ${target}`, cause)),
  )
}

/** The base environment of this bundle is in place: its marker says so, and its interpreter is there. */
async function installed(where: ReturnType<typeof layout>, id: string) {
  const text = await fsp.readFile(where.marker, "utf-8").catch(() => undefined)
  const marker = text === undefined ? undefined : decodeMarker(text)
  return marker !== undefined && Exit.isSuccess(marker) && marker.value.id === id && fs.existsSync(where.basePython)
}
