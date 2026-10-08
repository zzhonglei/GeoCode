export * as Pythons from "./pythons.ts"

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** A Python found with earthengine-api installed, read from its folders without starting it. */
export interface Found {
  readonly python: string
  /** How the user knows it: a conda environment's name, "base", a pyenv version, or where it comes from. */
  readonly name: string
  /** Python's, as far as its folders tell: in full from conda's records, major and minor otherwise. */
  readonly version?: string
  /** earthengine-api's, when its installation record names it. */
  readonly earthengine?: string
  /** The other packages GeoCode needs that are not there, by the names they install under. */
  readonly missing: readonly string[]
  /** The configured Python, by the file it is, whatever path names it. */
  readonly configured?: boolean
}

/** A folder a Python is installed into, and what to call it. */
export interface Place {
  readonly prefix: string
  readonly name: string
  /**
   * The user's own site-packages for a Python of this version, where `pip install --user` puts packages: for the
   * installations that read one, as Apple's Python, Homebrew's and python.org's do. Environments do not.
   */
  readonly userSite?: (version: string) => string
}

/** The packages besides earthengine-api, by the names they install under and their folders. */
const OTHERS = [
  { name: "geedim", module: "geedim" },
  { name: "geopandas", module: "geopandas" },
] as const

const CONDA_ROOTS = ["anaconda3", "miniconda3", "miniforge3", "mambaforge"]

/** Major and minor: "3.11.15" is 3.11. */
const minor = (version: string) => version.split(".").slice(0, 2).join(".")

/**
 * Where Pythons are commonly installed on this system: conda's own list of its environments and conda's usual
 * folders, pyenv's versions, virtualenvwrapper's environments, and Python's own installers, Homebrew's and, on macOS,
 * Apple's. A Python elsewhere, as most virtual environments are, is chosen by its folder.
 */
export async function places(platform: NodeJS.Platform = process.platform, env = process.env): Promise<Place[]> {
  const home = os.homedir()
  const found: Place[] = []
  const within = async (folder: string, name: (entry: string) => string) =>
    (await entries(folder)).map((entry) => ({ prefix: path.join(folder, entry), name: name(entry) }))

  // Conda names an environment in an envs folder by that folder's name, and its own root "base"; one made with
  // --prefix elsewhere is known by its folder's name.
  const listed = await fsp.readFile(path.join(home, ".conda", "environments.txt"), "utf8").catch(() => "")
  for (const line of listed.split(/\r?\n/)) {
    const prefix = line.trim()
    if (!prefix || !path.isAbsolute(prefix)) continue
    const inEnvs = path.basename(path.dirname(prefix)) === "envs"
    const root = !inEnvs && (await exists(path.join(prefix, "condabin")))
    found.push({ prefix, name: root ? "base" : path.basename(prefix) })
  }

  const roots =
    platform === "win32"
      ? [
          ...CONDA_ROOTS.map((root) => path.join(home, root)),
          ...[env.LOCALAPPDATA, env.ProgramData].flatMap((folder) =>
            folder ? CONDA_ROOTS.map((root) => path.join(folder, root)) : [],
          ),
          "C:\\anaconda3",
          "C:\\miniconda3",
        ]
      : [
          ...CONDA_ROOTS.map((root) => path.join(home, root)),
          ...["anaconda3", "miniconda3"].map((root) => path.join(home, "opt", root)),
          ...["/opt", "/opt/homebrew", "/usr/local"].flatMap((folder) =>
            CONDA_ROOTS.map((root) => path.join(folder, root)),
          ),
          ...["/opt/homebrew", "/usr/local"].flatMap((brew) =>
            ["miniforge", "miniconda", "anaconda"].map((cask) => path.join(brew, "Caskroom", cask, "base")),
          ),
        ]
  for (const root of roots) {
    found.push({ prefix: root, name: "base" }, ...(await within(path.join(root, "envs"), (entry) => entry)))
  }

  const pyenv =
    platform === "win32"
      ? path.join(home, ".pyenv", "pyenv-win", "versions")
      : path.join(env.PYENV_ROOT ?? path.join(home, ".pyenv"), "versions")
  for (const version of await within(pyenv, (entry) => `pyenv ${entry}`)) {
    found.push(version, ...(await within(path.join(version.prefix, "envs"), (entry) => entry)))
  }

  found.push(...(await within(path.join(home, ".virtualenvs"), (entry) => entry)))

  if (platform === "win32") {
    const appData = env.APPDATA
    const userSite = appData
      ? (version: string) => path.join(appData, "Python", `Python${minor(version).replace(".", "")}`, "site-packages")
      : undefined
    const installers = [
      // The python.org installer's, per user and for everyone, then its install manager's, from Python 3.14.
      { folder: env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Python"), pattern: /^Python3\d+/i },
      { folder: env.ProgramFiles, pattern: /^Python3\d+/i },
      { folder: env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Python"), pattern: /^pythoncore-3/i },
    ]
    for (const { folder, pattern } of installers) {
      if (!folder) continue
      for (const place of await within(folder, () => "Python.org")) {
        if (pattern.test(path.basename(place.prefix))) found.push({ ...place, userSite })
      }
    }
    return found
  }

  if (platform !== "darwin") return found
  const userSite = (version: string) =>
    path.join(home, "Library", "Python", minor(version), "lib", "python", "site-packages")
  found.push(
    { prefix: "/opt/homebrew", name: "Homebrew", userSite },
    { prefix: "/usr/local", name: "/usr/local", userSite },
  )
  const frameworks = [
    { folder: "/Library/Frameworks/Python.framework/Versions", name: "Python.org" },
    { folder: "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions", name: "macOS" },
    {
      folder: "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions",
      name: "macOS",
    },
  ]
  for (const framework of frameworks) {
    for (const place of await within(framework.folder, () => framework.name)) {
      if (path.basename(place.prefix) !== "Current") found.push({ ...place, userSite })
    }
  }
  return found
}

/** The Pythons in these places with earthengine-api installed, each once, in the order of the places. */
export async function discover(candidates: readonly Place[], platform: NodeJS.Platform = process.platform) {
  const seen = new Set<string>()
  const pythons: Found[] = []
  for (const place of candidates) {
    for (const each of await inspect(place, platform)) {
      const key = await fsp.realpath(each.site).catch(() => each.site)
      if (seen.has(key)) continue
      seen.add(key)
      pythons.push(each.found)
    }
  }
  return pythons
}

/**
 * Marks the configured Python among those found, by what each is: a link and its target are one Python, but a virtual
 * environment's interpreter, a link to the Python it was made from, is its own environment, known by its folder.
 */
export async function mark(pythons: readonly Found[], configured: string | undefined) {
  if (configured === undefined) return pythons
  const target = await identity(configured)
  const marked: Found[] = []
  for (const found of pythons) {
    marked.push((await identity(found.python)) === target ? { ...found, configured: true } : found)
  }
  return marked
}

/** A virtual environment's folder, the one holding pyvenv.cfg above its interpreter's; an interpreter's file otherwise. */
async function identity(python: string) {
  const real = (target: string) => fsp.realpath(target).catch(() => target)
  const environment = path.dirname(path.dirname(python))
  if (await exists(path.join(environment, "pyvenv.cfg"))) return `venv:${await real(environment)}`
  return real(python)
}

/**
 * The Python of an environment's folder, or of a project folder with its environment in .venv or venv, as the path
 * that names it there: a virtual environment's interpreter is a link to the Python it was made from, and resolving it
 * would leave the environment.
 */
export async function interpreterIn(folder: string, platform: NodeJS.Platform = process.platform) {
  const layouts =
    platform === "win32"
      ? [["python.exe"], ["Scripts", "python.exe"]]
      : [["bin", "python"], ["bin", "python3"], ["python"], ["python3"]]
  const candidates = ["", ".venv", "venv"].flatMap((inner) =>
    layouts.map((layout) => path.join(folder, inner, ...layout)),
  )
  for (const candidate of candidates) {
    const file = await fsp.stat(candidate).then(
      (stats) => stats.isFile(),
      () => false,
    )
    if (file) return candidate
  }
}

/**
 * The Pythons of one place with earthengine-api installed. On Windows a place holds one, at its root or, for a
 * virtual environment, in Scripts. Elsewhere it holds one for each Python 3 folder in its lib folder, as Homebrew's
 * does with several versions installed; a place with one is named by its plain `python` where it has one, as a conda
 * environment's is configured.
 */
async function inspect(place: Place, platform: NodeJS.Platform) {
  const conda = await condaPython(place.prefix)
  if (platform === "win32") {
    const python = await first([
      path.join(place.prefix, "python.exe"),
      path.join(place.prefix, "Scripts", "python.exe"),
    ])
    if (!python) return []
    const dll = (await entries(place.prefix)).map((entry) => /^python3(\d+)\.dll$/i.exec(entry)).find(Boolean)
    const version = conda ?? (dll ? `3.${dll[1]}` : await venvPython(place.prefix))
    const result = await packages(place, python, path.join(place.prefix, "Lib", "site-packages"), version)
    return result ? [result] : []
  }
  // Not the links among them: conda links python3.1 to python3.11's folder, for software that misreads the version.
  const lib = path.join(place.prefix, "lib")
  const versions: string[] = []
  for (const entry of await entries(lib)) {
    const version = /^python(3\.\d+)$/.exec(entry)?.[1]
    if (version === undefined) continue
    const link = await fsp.lstat(path.join(lib, entry)).then(
      (stats) => stats.isSymbolicLink(),
      () => true,
    )
    if (!link) versions.push(version)
  }
  const results = []
  for (const version of versions) {
    const bin = path.join(place.prefix, "bin")
    // The versioned one before python3, which another installation may have linked into a shared bin folder.
    const names = versions.length === 1 ? ["python", `python${version}`, "python3"] : [`python${version}`]
    const python = await first(names.map((name) => path.join(bin, name)))
    if (!python) continue
    const site = path.join(place.prefix, "lib", `python${version}`, "site-packages")
    const full = conda?.startsWith(`${version}.`) ? conda : version
    const result = await packages(place, python, site, full)
    if (result) results.push(result)
  }
  return results
}

/**
 * What a Python's site-packages folders hold of the packages, when earthengine-api is among them: its own folder's
 * and, for an installation that reads one, the user's. `site` is its own, which tells one Python from another.
 */
async function packages(place: Place, python: string, site: string, version: string | undefined) {
  // The user's first, as Python imports from it first, so the version shown is the one that runs.
  const sites = [...(place.userSite && version ? [place.userSite(version)] : []), site]
  const installed = await Promise.all(sites.map((folder) => exists(path.join(folder, "ee", "__init__.py"))))
  if (!installed.includes(true)) return
  const listed = (await Promise.all(sites.map(entries))).flat()
  const earthengine = listed.map((entry) => /^earthengine_api-(.+)\.(?:dist|egg)-info$/.exec(entry)?.[1]).find(Boolean)
  const missing = []
  for (const item of OTHERS) {
    if (!listed.includes(item.module)) missing.push(item.name)
  }
  const found: Found = {
    python,
    name: place.name,
    missing,
    ...(version === undefined ? {} : { version }),
    ...(earthengine === undefined ? {} : { earthengine }),
  }
  return { found, site }
}

/** Python's full version in a conda environment, from the record conda keeps of the package. */
async function condaPython(prefix: string) {
  const records = await entries(path.join(prefix, "conda-meta"))
  return records.map((entry) => /^python-(\d+\.\d+\.\d+)-.*\.json$/.exec(entry)?.[1]).find(Boolean)
}

/** A virtual environment's Python version, from the file it was made with. */
async function venvPython(prefix: string) {
  const configuration = await fsp.readFile(path.join(prefix, "pyvenv.cfg"), "utf8").catch(() => "")
  return /^version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/m.exec(configuration)?.[1]
}

async function first(candidates: readonly string[]) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate
}

async function exists(target: string) {
  return fsp.stat(target).then(
    () => true,
    () => false,
  )
}

async function entries(folder: string) {
  return fsp.readdir(folder).catch(() => [] as string[])
}
