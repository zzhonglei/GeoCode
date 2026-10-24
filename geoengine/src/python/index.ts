export * as Environment from "./index.ts"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Data, type Duration, Effect, Exit, Schema } from "effect"
import { Bundled } from "../bundled.ts"
import type { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"
import { Geocodekit } from "./geocodekit.ts"

const DOMAIN = "python"

const WINDOWS = process.platform === "win32"

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
 * Imported before the environment is ready (docs/PYTHON.md, section 6), each with the name the loading screen shows;
 * importing osgeo loads GDAL's driver plugins. matplotlib is left out: importing it writes in the user's home.
 */
const WARM = [
  ["numpy", "NumPy"],
  ["pandas", "pandas"],
  ["scipy.linalg", "SciPy"],
  ["shapely", "Shapely"],
  ["pyproj", "pyproj"],
  ["pyogrio", "pyogrio"],
  ["rasterio", "rasterio"],
  ["netCDF4", "netCDF4"],
  ["osgeo.gdal", "GDAL"],
  ["ee", "Earth Engine"],
  ["geedim", "geedim"],
  ["geopandas", "GeoPandas"],
] as const

/** Prints the number of each module it is given before importing it. */
const WARMING = [
  "import importlib, sys",
  "for number, name in enumerate(sys.argv[1:], 1):",
  "    print(number)",
  "    importlib.import_module(name)",
].join("\n")

/** Written into the base environment's site-packages as STARTUP_MODULE, which a .pth file beside it imports. */
const STARTUP = `"""Sets GeoCode's Python environment's own variables as Python starts, and has it take its proxy
from the proxy variables alone, as GeoCode's kernel does (docs/PYTHON.md, section 6.1)."""

import os
import sys

# Always reached directly, as the kernel and the shell reach them; urllib compares an IPv6 host with its brackets.
_LOOPBACK = ("localhost", "127.0.0.1", "::1", "[::1]")


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


def _arrange_proxy():
    environ = os.environ
    # Neither the kernel's model requests nor the shell server follow it.
    environ.pop("ALL_PROXY", None)
    environ.pop("all_proxy", None)
    # libcurl, as GDAL and PROJ use it, reads http_proxy in lowercase alone.
    if "http_proxy" not in environ and environ.get("HTTP_PROXY"):
        environ["http_proxy"] = environ["HTTP_PROXY"]
    if not any(environ.get(name) for name in ("http_proxy", "https_proxy", "HTTPS_PROXY")):
        return
    bypass = environ.get("no_proxy", environ.get("NO_PROXY", ""))
    hosts = [host.strip() for host in bypass.split(",") if host.strip()]
    # "*" stands for every host only alone.
    if hosts == ["*"]:
        return
    hosts += [host for host in _LOOPBACK if host not in hosts]
    environ["no_proxy"] = environ["NO_PROXY"] = ",".join(hosts)


def _proxies_from_variables(request):
    # Without a variable, urllib would take the system's proxy settings; requests and aiohttp take theirs from it.
    request.getproxies = request.getproxies_environment
    request.proxy_bypass = request.proxy_bypass_environment


def _sessions_read_variables(client):
    session = client.ClientSession
    init = session.__init__

    # As requests' sessions do, unless told not to.
    def __init__(self, *args, trust_env=True, **kwargs):
        init(self, *args, trust_env=trust_env, **kwargs)

    session.__init__ = __init__


# By module, once it has run: neither is imported here, which would slow every start.
_ADJUSTED = {"urllib.request": _proxies_from_variables, "aiohttp.client": _sessions_read_variables}


class _Adjusting:
    def find_spec(self, name, path=None, target=None):
        adjust = _ADJUSTED.get(name)
        if adjust is None:
            return None
        from importlib.machinery import PathFinder

        spec = PathFinder.find_spec(name, path)
        if spec is None or not hasattr(spec.loader, "exec_module"):
            return spec
        execute = spec.loader.exec_module

        def exec_module(module):
            execute(module)
            adjust(module)

        spec.loader.exec_module = exec_module
        return spec


_set_variables()
_arrange_proxy()
for _name, _adjust in _ADJUSTED.items():
    if _name in sys.modules:
        _adjust(sys.modules[_name])
del _name, _adjust
sys.meta_path.insert(0, _Adjusting())
`

/** The module STARTUP is written as, and the name of the .pth file that imports it. */
const STARTUP_MODULE = "_geocode_environment"

const STARTUP_PTH = `import ${STARTUP_MODULE}\n`

/** pip and uv refuse to install into the base environment (PEP 668). */
const EXTERNALLY_MANAGED =
  "[externally-managed]\nError=No packages can be installed into GeoCode's base Python environment.\n"

/** How the names of the files GeoEngine writes before moving them into place start; a start cut short leaves them. */
const WRITING = ".writing-"

/** geocodekit's dist-info folders, of any version. */
const DIST_INFO = new RegExp(`^${Geocodekit.NAME}-.+\\.dist-info$`)

/** Both from the main process. */
export interface Places {
  /** The folder holding what scripts/stage-python.sh staged: python.tar, pixi-unpack and python.json. */
  readonly bundle: string
  /** GeoCode's data directory, whose python folder holds the environment. */
  readonly data: string
}

/** What scripts/stage-python.sh writes beside the packages. */
const Bundle = Schema.Struct({ id: Schema.String, python: Schema.String })

const Marker = Schema.Struct({ id: Schema.String })

const decodeBundle = Schema.decodeUnknownExit(Schema.fromJsonString(Bundle))
const decodeMarker = Schema.decodeUnknownExit(Schema.fromJsonString(Marker))

type Step = "bundle" | "install" | "files" | "environment"

export interface Diagnostics {
  readonly step: Step
  readonly message: string
  /** What the command printed, when one failed. */
  readonly output?: string
}

export type State =
  | { readonly status: "checking" }
  | { readonly status: "preparing"; readonly step: "installing" | "creating" }
  /** After installing or creating only: another start warms up too quickly to show. `number` counts from 1. */
  | {
      readonly status: "preparing"
      readonly step: "warming"
      readonly name: string
      readonly number: number
      readonly total: number
    }
  /** `python` is the working environment's interpreter, for GeoAgent; `base` the base environment's. */
  | { readonly status: "ready"; readonly version: string; readonly python: string; readonly base: string }
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
 * the bundled one when the data directory has another or none, brings the files GeoEngine writes into it to this
 * GeoCode's, makes the working environment when it is missing, and warms the environment up before calling it ready.
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

    const python = (command: string, args: readonly string[], total: Duration.Input) =>
      runtime.run({ ...Bundled.python(command, args), delivery: { mode: "collect" }, clocks: { total } })

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
              env: { TMPDIR: temporary, TMP: temporary, TEMP: temporary, ...Bundled.home() },
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
            await prune(where.base)
            await fsp.writeFile(where.marker, JSON.stringify({ id: bundle.id }) + "\n")
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

    const runSync = Effect.runSyncWith(yield* Effect.context<never>())

    // Through base, which nothing GeoAgent installs can change; only a speed-up, so a failure is only logged.
    const warm = (shown: boolean) => {
      // Off once the run has settled: output delivered after it would commit past ready.
      let reporting = shown
      let pending = ""
      const onChunk = (chunk: string) => {
        if (!reporting) return
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ""
        for (const line of lines) {
          const number = Number(line)
          const name = WARM[number - 1]?.[1]
          if (name === undefined) continue
          // Committed at once: a commit left for later could land after ready and take it back.
          runSync(writer.commit(token, { status: "preparing", step: "warming", name, number, total: WARM.length }))
        }
      }
      return runtime
        .run({
          ...Bundled.python(where.basePython, ["-c", WARMING, ...WARM.map(([module]) => module)]),
          delivery: { mode: "incremental", onChunk },
          clocks: { total: WARM_TIMEOUT },
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reporting = false
            }),
          ),
          Effect.flatMap((result) =>
            result.reason === "exit" && result.code === 0
              ? Effect.void
              : Effect.logWarning("GeoEngine could not warm up the Python environment", {
                  reason: result.reason,
                  code: result.code,
                  signal: result.signal,
                  stderr: result.stderr.slice(-OUTPUT_TAIL),
                }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("GeoEngine could not warm up the Python environment", error.message),
          ),
        )
    }

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
        if (name.startsWith(UNPACKING) || name.startsWith(ACTIVATION) || name.startsWith(WRITING)) {
          yield* remove(path.join(where.root, name))
        }
      }

      const installing = !(yield* Effect.promise(() => installed(where, bundle.id)))
      if (installing) yield* install(bundle)
      // At every start, installed now or before; a base without them is not one this GeoCode can use.
      yield* attempt("files", () => update(where, bundle.python))
      const creating = !fs.existsSync(where.envPython)
      if (creating) yield* create()
      // Before ready, so nothing that waits for it meets a library loaded for the first time.
      yield* warm(installing || creating)
      yield* writer.commit(token, {
        status: "ready",
        version: bundle.python,
        python: where.envPython,
        base: where.basePython,
      })
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

/** The base environment of this bundle is in place: its marker says so, and its interpreter is there. */
async function installed(where: ReturnType<typeof layout>, id: string) {
  const text = await fsp.readFile(where.marker, "utf-8").catch(() => undefined)
  const marker = text === undefined ? undefined : decodeMarker(text)
  if (marker === undefined || Exit.isFailure(marker)) return false
  return marker.value.id === id && fs.existsSync(where.basePython)
}

/**
 * What GeoEngine writes into the base environment beside the packages, by path, as this GeoCode writes it: the
 * EXTERNALLY-MANAGED file, the startup file, and geocodekit with its dist-info. The startup module comes before the
 * .pth file that imports it, so a start cut short never leaves the .pth file without the module.
 */
function own(where: ReturnType<typeof layout>, python: string) {
  const stdlib = where.stdlib(python)
  const site = path.join(stdlib, "site-packages")
  const files = Object.entries(Geocodekit.PACKAGE.files)
  const written = new Map([
    [path.join(stdlib, "EXTERNALLY-MANAGED"), EXTERNALLY_MANAGED],
    [path.join(site, `${STARTUP_MODULE}.py`), STARTUP],
    [path.join(site, `${STARTUP_MODULE}.pth`), STARTUP_PTH],
  ])
  for (const [file, text] of [...files, ...distInfo(Geocodekit.PACKAGE.version, files)]) {
    written.set(path.join(site, ...file.split("/")), text)
  }
  return { site, written }
}

/**
 * geocodekit's dist-info, as pip writes one: its metadata with GeoCode's version, who installed it, and the record of
 * the package's files and their hashes. By paths under site-packages.
 */
function distInfo(version: string, files: readonly (readonly [string, string])[]) {
  // A dash in a version would be taken for the end of the name.
  const folder = `${Geocodekit.NAME}-${version.replaceAll("-", "_")}.dist-info`
  const listed: [string, string][] = [
    [`${folder}/METADATA`, `Metadata-Version: 2.1\nName: ${Geocodekit.NAME}\nVersion: ${version}\n`],
    [`${folder}/INSTALLER`, "GeoCode\n"],
  ]
  const hash = (text: string) => `sha256=${createHash("sha256").update(text).digest("base64url")}`
  const record = [...files, ...listed].map(([file, text]) => `${file},${hash(text)},${Buffer.byteLength(text)}`)
  return [...listed, [`${folder}/RECORD`, [...record, `${folder}/RECORD,,`].join("\n") + "\n"] as const]
}

/**
 * How the base environment differs from what this GeoCode writes into it (docs/PYTHON.md, section 6), by each file's
 * content: the files to write, missing or other, with their texts, and what of geocodekit's is there besides, to
 * remove. Python's bytecode caches are its own.
 */
export async function compare(where: ReturnType<typeof layout>, python: string) {
  const { site, written } = own(where, python)
  const write: [string, string][] = []
  for (const [file, text] of written) {
    const found = await fsp.readFile(file).catch(() => undefined)
    if (!found?.equals(Buffer.from(text))) write.push([file, text])
  }
  // The folders under site-packages holding a file that is written.
  const kept = new Set<string>()
  for (const file of written.keys()) {
    for (let folder = path.dirname(file); folder.startsWith(site + path.sep); folder = path.dirname(folder)) {
      kept.add(folder)
    }
  }
  const remove: string[] = []
  const visit = async (folder: string) => {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const inside = path.join(folder, entry.name)
      if (entry.isDirectory() && entry.name === "__pycache__") continue
      if (entry.isDirectory() && kept.has(inside)) await visit(inside)
      else if (!written.has(inside)) remove.push(inside)
    }
  }
  for (const name of await fsp.readdir(site).catch(() => [])) {
    if (name !== Geocodekit.NAME && !DIST_INFO.test(name)) continue
    if (kept.has(path.join(site, name))) await visit(path.join(site, name))
    else remove.push(path.join(site, name))
  }
  return { write, remove }
}

/**
 * Brings what GeoEngine writes into the base environment to this GeoCode's: only what differs is written, each file
 * moved into place whole, so a start with nothing changed writes nothing, and a Python running meanwhile never reads
 * half a file.
 */
async function update(where: ReturnType<typeof layout>, python: string) {
  const { write, remove } = await compare(where, python)
  for (const target of remove) await fsp.rm(target, { recursive: true, force: true })
  for (const [file, text] of write) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const temporary = path.join(where.root, `${WRITING}${randomUUID()}`)
    await fsp.writeFile(temporary, text)
    await fsp.rename(temporary, file)
  }
}
