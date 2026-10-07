export * as Windows from "./windows.ts"

import fsp from "node:fs/promises"
import path from "node:path"
import { Installs } from "./installs.ts"

// Windows paths whatever the platform, so the logic is tested where the tests run.
const win = path.win32

// One QGIS: the standalone installer and OSGeo4W lay out the same packages, `<root>\apps\<name>` beside its launcher
// `<root>\bin\python-<name>.bat`, and OSGeo4W may hold several names in one root.
export type Located =
  | { readonly ok: true; readonly install: Installs.Install }
  | {
      readonly ok: false
      readonly status: "path-missing" | "not-qgis" | "python-missing" | "ambiguous"
      readonly message: string
      readonly app?: string
      readonly version?: string
      /** The root holding more than one QGIS, and those that can start, when the path does not say which it means. */
      readonly folder?: string
      readonly choices?: readonly Installs.Found[]
    }

/** What looking at QGIS's folders reads; the disk itself on Windows. */
export interface Disk {
  /** A folder's entries as the disk spells them; empty when it cannot be read. */
  readonly list: (folder: string) => Promise<readonly { readonly name: string; readonly folder: boolean }[]>
  readonly read: (file: string) => Promise<string | undefined>
  readonly exists: (target: string) => Promise<boolean>
}

const DISK: Disk = {
  list: (folder) =>
    fsp.readdir(folder, { withFileTypes: true }).then(
      (entries) =>
        Promise.all(
          entries.map(async (entry) => ({
            name: entry.name,
            // Windows reports every reparse point as a link: a junction to a folder moved elsewhere, and a file kept by
            // deduplication or a cloud drive alike.
            folder: entry.isSymbolicLink()
              ? await fsp.stat(win.join(folder, entry.name)).then(
                  (stats) => stats.isDirectory(),
                  () => false,
                )
              : entry.isDirectory(),
          })),
        ),
      () => [],
    ),
  read: (file) => fsp.readFile(file, "utf-8").catch(() => undefined),
  exists: (target) =>
    fsp.stat(target).then(
      () => true,
      () => false,
    ),
}

const LAUNCHER = /^python-(qgis.*)\.bat$/i

/** The program QGIS's shortcuts start, which is where a user who looks for QGIS finds it. */
const PROGRAM = /^(qgis.*)-bin\.exe$/i

/** How GeoAgent finds QGIS on this computer, for setting it up itself. */
export const FINDING =
  "Find QGIS on this computer: QGIS is usually installed in a folder such as C:\\Program Files\\QGIS 3.44.15 or C:\\OSGeo4W, on any drive; a QGIS folder has bin\\python-qgis*.bat. If there is more than one, ask the user which to use."

/** How GeoAgent writes the path into machine.json, after "Its configuration is in <file>, ". */
export const CONFIGURED = 'as {"qgis": {"path": "<QGIS folder>"}}, with each backslash in the path written twice.'

/** Why a QGIS without its launcher does not work, for GeoAgent. */
export const NO_PYTHON = "it has no bin\\python-qgis*.bat to start its Python with"

/** Finds the QGIS a configured path points at or into, and QGIS's launcher for its Python. */
export async function locate(configured: string, disk = DISK): Promise<Located> {
  // A relative path in a configuration file is almost always a mistake, and would resolve against the engine's own
  // working directory.
  if (!win.isAbsolute(configured)) {
    return { ok: false, status: "path-missing", message: `${configured} is not an absolute path` }
  }
  const resolved = win.resolve(configured)
  if (!(await disk.exists(resolved))) {
    return { ok: false, status: "path-missing", message: `${resolved} does not exist` }
  }

  const root = await rootOf(resolved, disk)
  if (!root) return { ok: false, status: "not-qgis", message: `${resolved} is not inside a QGIS folder` }
  const installs = await installsIn(root, disk)

  // A path into one QGIS of the root means that one, and never another; otherwise the one in it that can start,
  // whatever else is left.
  const named = nameIn(win.relative(root, resolved))
  const meant = named === undefined ? undefined : installs.find((install) => same(install.name, named))
  if (named !== undefined && !meant) {
    return { ok: false, status: "not-qgis", message: `${root} holds no QGIS named ${named}` }
  }
  const startable = installs.filter((install) => install.interpreter)
  const chosen = meant ?? (startable.length === 1 ? startable[0] : undefined)
  if (chosen?.interpreter) {
    return { ok: true, install: { app: chosen.app, interpreter: chosen.interpreter, version: chosen.version } }
  }
  if (chosen || (startable.length === 0 && installs.length === 1)) {
    const { name, app, version } = chosen ?? installs[0]!
    const message = `${root} has no bin\\python-${name}.bat to start its Python with`
    return { ok: false, status: "python-missing", message, app, version }
  }
  if (startable.length > 1) {
    const choices = startable.map(({ app, version }) => ({ app, version }))
    return { ok: false, status: "ambiguous", message: `${root} holds more than one QGIS`, folder: root, choices }
  }
  if (installs.length > 1) {
    const message = `${root} has no bin\\python-qgis*.bat to start any of its QGIS with`
    return { ok: false, status: "python-missing", message }
  }
  return { ok: false, status: "not-qgis", message: `${root} holds no QGIS` }
}

/**
 * The system program that lists the fixed disks, which a mapped network drive that is gone would stall. A cmdlet and
 * not .NET, which PowerShell refuses where the machine's policy constrains its language.
 */
export const drivesCommand = () => ({
  command: win.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  // Encoded, so no quoting of the command line stands between PowerShell and the script.
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(
      "Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }",
      "utf16le",
    ).toString("base64"),
  ],
})

/** The roots of the drives in the program's output, which names them as C:. */
export function drives(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z]:$/.test(line))
    .map((line) => `${line.toUpperCase()}\\`)
}

/**
 * The QGIS installs where the installers put them, on every fixed drive, newest first: the standalone installer's
 * `Program Files\QGIS <version>` and OSGeo4W's `OSGeo4W` at a drive's root, which some move to a drive other than C:.
 * Without the drives, the system drive is looked at.
 */
export async function installs(
  fixed: readonly string[],
  disk = DISK,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Installs.Found[]> {
  const roots = fixed.length ? fixed : [`${environment.SystemDrive ?? "C:"}\\`]
  const programs = [environment.ProgramFiles, environment.ProgramW6432].filter((folder) => folder !== undefined)
  const named = async (folder: string, prefixes: readonly string[]) =>
    (await disk.list(folder))
      .filter((entry) => entry.folder && prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix)))
      .map((entry) => win.join(folder, entry.name))
  const candidates = (
    await Promise.all([
      ...roots.map((drive) => named(drive, ["osgeo4w", "qgis"])),
      ...roots.map((drive) => named(win.join(drive, "Program Files"), ["qgis"])),
      ...programs.map((folder) => named(folder, ["qgis"])),
    ])
  ).flat()
  // Once each: ProgramFiles is C:\Program Files as a rule, which the drives were looked at for already.
  const found = new Map<string, Installs.Found>()
  for (const root of candidates) {
    for (const { app, version } of await installsIn(root, disk)) {
      if (!found.has(app.toLowerCase())) found.set(app.toLowerCase(), { app, version })
    }
  }
  return Installs.newestFirst([...found.values()])
}

/** What a task adds to the engine's environment; QGIS's launcher sets the rest. */
export function environment(_install: Installs.Install): Record<string, string> {
  return {
    // An older launcher may not set UTF-8 mode, and without it a traceback with Chinese in it arrives in the system's
    // code page.
    PYTHONIOENCODING: "utf-8",
    // Off: Qt's own diagnostics, which a run would pass on with what QGIS, GDAL and PROJ write.
    QT_LOGGING_RULES: "qt.*=false",
  }
}

interface Candidate {
  readonly name: string
  readonly app: string
  readonly interpreter: string | undefined
  readonly version: string | undefined
}

/** The nearest folder at or above the path that holds a QGIS, as the disk spells it. */
async function rootOf(resolved: string, disk: Disk) {
  for (let folder = resolved; ; folder = win.dirname(folder)) {
    const bin = await disk.list(win.join(folder, "bin"))
    const apps = await disk.list(win.join(folder, "apps"))
    const launcher = bin.some((entry) => !entry.folder && LAUNCHER.test(entry.name))
    if (launcher || (bin.length && apps.some((entry) => entry.folder && qgisNamed(entry.name)))) {
      return spelled(folder, disk)
    }
    if (win.dirname(folder) === folder) return undefined
  }
}

/** Each QGIS in a root, with its launcher where it has one. */
async function installsIn(root: string, disk: Disk): Promise<Candidate[]> {
  const launchers = (await disk.list(win.join(root, "bin"))).filter(
    (entry) => !entry.folder && LAUNCHER.test(entry.name),
  )
  const apps = (await disk.list(win.join(root, "apps"))).filter((entry) => entry.folder && qgisNamed(entry.name))
  const packages = (await disk.read(win.join(root, "etc", "setup", "installed.db"))) ?? ""
  return apps
    .map((entry) => {
      const launcher = launchers.find((candidate) => same(candidate.name.match(LAUNCHER)![1]!, entry.name))
      return {
        name: entry.name,
        app: win.join(root, "apps", entry.name),
        interpreter: launcher && win.join(root, "bin", launcher.name),
        version: versionOf(packages, entry.name),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The QGIS a path inside a root names: `apps\<name>\…`, its launcher, or the program its shortcuts start. */
function nameIn(relative: string) {
  const [first, written] = relative.split(win.sep)
  if (!written) return undefined
  // Windows drops the spaces and dots a name ends in, so the path names the folder without them.
  const second = written.replace(/[. ]+$/, "")
  if (same(first!, "apps")) return qgisNamed(second) ? second : undefined
  if (!same(first!, "bin")) return undefined
  return (second.match(LAUNCHER) ?? second.match(PROGRAM))?.[1]
}

/**
 * The package list both installers keep, a line per package such as `qgis-ltr qgis-ltr-3.44.15-1.tar.bz2 0`; QGIS's
 * package is named as its folder in apps.
 */
function versionOf(packages: string, name: string) {
  for (const line of packages.split(/\r?\n/)) {
    const [packaged, file] = line.trim().split(/\s+/)
    if (!packaged || !file || !same(packaged, name)) continue
    if (!file.toLowerCase().startsWith(`${name.toLowerCase()}-`)) continue
    return file.slice(name.length + 1).match(/^(\d[\w.]*)-/)?.[1]
  }
  return undefined
}

/** The path as the disk spells it: Windows ignores case, and a path written by hand differs from one found. */
async function spelled(target: string, disk: Disk) {
  const { root } = win.parse(target)
  let result = root.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
  for (const part of target.slice(root.length).split(win.sep).filter(Boolean)) {
    const entry = (await disk.list(result)).find((candidate) => same(candidate.name, part))
    result = win.join(result, entry?.name ?? part)
  }
  return result
}

function qgisNamed(name: string) {
  return name.toLowerCase().startsWith("qgis")
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}
