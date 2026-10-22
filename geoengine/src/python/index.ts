export * as Environment from "./index.ts"

import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Data, type Duration, Effect, Exit, Schema } from "effect"
import type { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"

const DOMAIN = "python"

const WINDOWS = process.platform === "win32"

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"

/** Staged beside the packages; it installs them as conda would (docs/PYTHON.md, section 4). */
const UNPACK = WINDOWS ? "pixi-unpack.exe" : "pixi-unpack"

/** A slow disk, or a scan of each new file, can take minutes over the many small files. */
const INSTALL_TIMEOUT = "20 minutes"

const CREATE_TIMEOUT = "2 minutes"

const WARM_TIMEOUT = "10 minutes"

/** Characters kept of what a failed command printed, the latest. */
const OUTPUT_TAIL = 16 * 1024

/** The name of pixi-unpack's temporary folder, where it unpacks the packages, followed by mkdtemp's random part. */
const UNPACKING = ".unpack-"

/** How the name of the activation script pixi-unpack writes beside the environment starts; GeoCode does not use it. */
const ACTIVATION = "activate."

/** Files only building and debugging use, removed once installed: link libraries and debug symbols. */
const UNUSED = new Set([".a", ".lib", ".pdb"])

/**
 * Imported once the environment is ready (docs/PYTHON.md, section 6); importing osgeo loads GDAL's driver plugins.
 * matplotlib is left out: importing it writes in the user's home.
 */
const WARM = ["numpy", "pandas", "scipy.linalg", "shapely", "pyproj", "pyogrio", "rasterio", "netCDF4", "osgeo.gdal"]

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
 * Given with `inherit: false` (docs/PYTHON.md, section 6.1); the environment sets its own variables as it starts
 * (STARTUP). On Windows Node copies the system variables a process needs from the engine's environment when they are
 * missing, PATH among them, so the system's own PATH takes the place of the user's.
 */
const environment = () => {
  const result: Record<string, string> = home()
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && NETWORK.has(name.toUpperCase())) result[name] = value
  }
  if (WINDOWS) result.PATH = [path.join(SYSTEM_ROOT, "System32"), SYSTEM_ROOT].join(";")
  return result
}

/** Written into the base environment's site-packages as STARTUP_MODULE, which a .pth file beside it imports. */
const STARTUP = `"""Sets GeoCode's Python environment's own variables as Python starts (docs/PYTHON.md, section 6.1)."""

import os
import sys


def _set_variables():
    base = sys.base_prefix
    library = os.path.join(base, "Library") if sys.platform == "win32" else base
    os.environ["GDAL_DATA"] = os.path.join(library, "share", "gdal")
    os.environ["GDAL_DRIVER_PATH"] = os.path.join(library, "lib", "gdalplugins")
    os.environ["PROJ_DATA"] = os.path.join(library, "share", "proj")
    # As conda's activation turns it on without the grids installed: a transformation that needs one fetches what it
    # uses, kept beside the base environment rather than in the user's folders.
    os.environ["PROJ_NETWORK"] = "ON"
    os.environ["PROJ_USER_WRITABLE_DIRECTORY"] = os.path.join(os.path.dirname(base), "proj")
    # A file that is never there, read in place of the user's ~/.gdal/gdalrc.
    os.environ["GDAL_CONFIG_FILE"] = os.path.join(base, "gdalrc")
    if sys.platform == "win32":
        # OpenSSL on Windows finds no certificates of its own; the user's, when given, are kept.
        for name, value in [
            ("SSL_CERT_FILE", os.path.join(library, "ssl", "cacert.pem")),
            ("SSL_CERT_DIR", os.path.join(library, "ssl", "certs")),
        ]:
            if not os.environ.get(name):
                os.environ[name] = value
        # First the folders conda's activation puts first, for the DLLs of the environment and the programs it starts.
        first = [base] + [os.path.join(library, folder, "bin") for folder in ("mingw-w64", "usr", "")]
        first += [os.path.join(base, "Scripts"), os.path.join(base, "bin")]
        rest = [folder for folder in os.environ.get("PATH", "").split(os.pathsep) if folder and folder not in first]
        os.environ["PATH"] = os.pathsep.join(first + rest)


_set_variables()
`

/** The module STARTUP is written as, and the name of the .pth file that imports it. */
const STARTUP_MODULE = "_geocode_environment"

const STARTUP_PTH = `import ${STARTUP_MODULE}\n`

/** Without it a program finds the account's home from the system, past a sandbox that moved it. */
const home = (): Record<string, string> => (process.env.HOME === undefined ? {} : { HOME: process.env.HOME })

/** pip and uv refuse to install into the base environment (PEP 668). */
const EXTERNALLY_MANAGED =
  "[externally-managed]\nError=No packages can be installed into GeoCode's base Python environment.\n"

/**
 * What GeoEngine writes into the base environment beside the packages, noted in the marker: a GeoCode that writes it
 * otherwise installs the environment again, so no base keeps an older startup file.
 */
const WRITTEN = createHash("sha256")
  .update(EXTERNALLY_MANAGED)
  .update(STARTUP_MODULE)
  .update(STARTUP_PTH)
  .update(STARTUP)
  .digest("hex")

/** Both from the main process. */
export interface Places {
  /** The folder holding what scripts/stage-python.sh staged: python.tar, pixi-unpack and python.json. */
  readonly bundle: string
  /** GeoCode's data directory, whose python folder holds the environment. */
  readonly data: string
}

/** What scripts/stage-python.sh writes beside the packages. */
const Bundle = Schema.Struct({ id: Schema.String, python: Schema.String })

const Marker = Schema.Struct({ id: Schema.String, written: Schema.String })

const decodeBundle = Schema.decodeUnknownExit(Schema.fromJsonString(Bundle))
const decodeMarker = Schema.decodeUnknownExit(Schema.fromJsonString(Marker))

type Step = "bundle" | "install" | "environment"

export interface Diagnostics {
  readonly step: Step
  readonly message: string
  /** What the command printed, when one failed. */
  readonly output?: string
}

export type State =
  | { readonly status: "checking" }
  | { readonly status: "preparing"; readonly step: "installing" | "creating" }
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
    /** The base environment's standard library, for its Python version, such as 3.13.17. */
    stdlib: (version: string) =>
      WINDOWS ? path.join(base, "Lib") : path.join(base, "lib", `python${version.split(".").slice(0, 2).join(".")}`),
  }
}

/**
 * Prepares GeoCode's Python environment in the background as the engine starts (docs/PYTHON.md, section 6): installs
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

    // In place: conda's packages note where they are installed, so the base environment cannot be moved there later.
    const install = (bundle: typeof Bundle.Type) =>
      Effect.gen(function* () {
        yield* writer.commit(token, { status: "preparing", step: "installing" })
        // The marker first: a start that finds none installs again, whatever this one leaves.
        yield* attempt("install", async () => {
          await fsp.rm(where.marker, { force: true })
          // The working environment was made from the base one this replaces.
          await fsp.rm(where.env, { recursive: true, force: true })
          await fsp.rm(where.base, { recursive: true, force: true })
          await fsp.mkdir(where.root, { recursive: true })
        })
        const temporary = yield* attempt("install", () => fsp.mkdtemp(path.join(where.root, UNPACKING)))
        yield* Effect.gen(function* () {
          const result = yield* runtime
            .run({
              command: path.join(places.bundle, UNPACK),
              args: [path.join(places.bundle, "python.tar"), "--output-directory", where.root, "--env-name", "base"],
              // Its unpacked packages stay in the data directory, where the next start clears what it leaves.
              env: { TMPDIR: temporary, TMP: temporary, TEMP: temporary, ...home() },
              inherit: false,
              delivery: { mode: "collect" },
              clocks: { total: INSTALL_TIMEOUT },
            })
            .pipe(Effect.mapError((error) => new Failed({ step: "install", message: error.message })))
          yield* expect("install", "pixi-unpack", result, result.stderr || result.stdout)

          yield* attempt("install", async () => {
            for (const name of await fsp.readdir(where.root)) {
              if (name.startsWith(ACTIVATION)) await fsp.rm(path.join(where.root, name))
            }
            const stdlib = where.stdlib(bundle.python)
            await fsp.writeFile(path.join(stdlib, "EXTERNALLY-MANAGED"), EXTERNALLY_MANAGED)
            const site = path.join(stdlib, "site-packages")
            await fsp.writeFile(path.join(site, `${STARTUP_MODULE}.py`), STARTUP)
            await fsp.writeFile(path.join(site, `${STARTUP_MODULE}.pth`), STARTUP_PTH)
            await prune(where.base)
            await fsp.writeFile(where.marker, JSON.stringify({ id: bundle.id, written: WRITTEN }) + "\n")
          })
        }).pipe(Effect.ensuring(remove(temporary)))
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
      // What an installation cut short left behind.
      const left = yield* Effect.promise(() => fsp.readdir(where.root).catch(() => [] as string[]))
      for (const name of left) {
        if (name.startsWith(UNPACKING) || name.startsWith(ACTIVATION)) yield* remove(path.join(where.root, name))
      }

      if (!(yield* Effect.promise(() => installed(where, bundle.id)))) yield* install(bundle)
      if (!fs.existsSync(where.envPython)) yield* create()
      yield* writer.commit(token, { status: "ready", version: bundle.python, python: where.envPython })
      yield* warm
    }).pipe(
      Effect.catchTag("GeoEnginePythonFailed", (failed) => {
        const diagnostics = {
          step: failed.step,
          message: failed.message,
          ...(failed.output ? { output: failed.output } : {}),
        }
        // Into the app's log as well: no window shows the environment.
        return Effect.logWarning("GeoEngine could not prepare the Python environment", diagnostics).pipe(
          Effect.andThen(writer.commit(token, { status: "failed", diagnostics })),
        )
      }),
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

/** Takes away what only building and debugging use (docs/PYTHON.md, section 6). */
async function prune(base: string) {
  for (const headers of [path.join(base, "include"), path.join(base, "Library", "include")]) {
    await fsp.rm(headers, { recursive: true, force: true })
  }
  for (const entry of await fsp.readdir(base, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && UNUSED.has(path.extname(entry.name).toLowerCase())) {
      await fsp.rm(path.join(entry.parentPath, entry.name))
    }
  }
}

/**
 * The base environment of this bundle, as this GeoCode writes it, is in place: its marker says so, and its interpreter
 * is there.
 */
async function installed(where: ReturnType<typeof layout>, id: string) {
  const text = await fsp.readFile(where.marker, "utf-8").catch(() => undefined)
  const marker = text === undefined ? undefined : decodeMarker(text)
  if (marker === undefined || Exit.isFailure(marker)) return false
  return marker.value.id === id && marker.value.written === WRITTEN && fs.existsSync(where.basePython)
}
