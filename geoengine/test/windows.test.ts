import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { Windows } from "../src/qgis/windows.ts"

const win = path.win32

/** A Windows disk holding these files, every folder above them implied; names are found without regard to case. */
const disk = (files: Record<string, string>): Windows.Disk => {
  const folders = new Map<string, Map<string, { name: string; folder: boolean }>>()
  const contents = new Map<string, string>()
  for (const [file, content] of Object.entries(files)) {
    contents.set(file.toLowerCase(), content)
    for (let child = file, folder = win.dirname(file); child !== folder; child = folder, folder = win.dirname(folder)) {
      const entries = folders.get(folder.toLowerCase()) ?? new Map()
      entries.set(win.basename(child).toLowerCase(), { name: win.basename(child), folder: child !== file })
      folders.set(folder.toLowerCase(), entries)
    }
  }
  // As Windows does, the spaces and dots a name ends in are dropped.
  const key = (target: string) =>
    win
      .resolve(target)
      .split(win.sep)
      .map((part) => (part.endsWith(":") ? part : part.replace(/[. ]+$/, "")))
      .join(win.sep)
      .toLowerCase()
  return {
    list: async (folder) => [...(folders.get(key(folder))?.values() ?? [])],
    read: async (file) => contents.get(key(file)),
    exists: async (target) => contents.has(key(target)) || folders.has(key(target)),
  }
}

const packages = (...lines: string[]) => ["INSTALLED.DB 2", ...lines.map((line) => `${line} 0`)].join("\n") + "\n"

/** What the installers lay out for one QGIS, as the OSGeo4W packages hold it. */
const qgis = (root: string, name: string) => ({
  [win.join(root, "bin", `python-${name}.bat`)]: "",
  [win.join(root, "bin", `${name}-bin.exe`)]: "",
  [win.join(root, "bin", `${name}.bat`)]: "",
  [win.join(root, "bin", `qgis_process-${name}.bat`)]: "",
  [win.join(root, "apps", name, "bin", "qgis_core.dll")]: "",
  [win.join(root, "apps", name, "python", "qgis", "__init__.py")]: "",
})

const common = (root: string) => ({
  [win.join(root, "bin", "o4w_env.bat")]: "",
  [win.join(root, "bin", "python.exe")]: "",
  [win.join(root, "apps", "Python312", "python.exe")]: "",
  [win.join(root, "etc", "ini", "python3.bat")]: "",
})

const LTR = "C:\\Program Files\\QGIS 3.44.15"
const CURRENT = "C:\\Program Files\\QGIS 4.2.3"
const OSGEO4W = "D:\\OSGeo4W"

const DISK = disk({
  ...common(LTR),
  ...qgis(LTR, "qgis-ltr"),
  [win.join(LTR, "etc", "setup", "installed.db")]: packages(
    "qgis-ltr qgis-ltr-3.44.15-1.tar.bz2",
    "qgis-ltr-common qgis-ltr-common-3.44.15-1.tar.bz2",
  ),
  ...common(CURRENT),
  ...qgis(CURRENT, "qgis"),
  [win.join(CURRENT, "etc", "setup", "installed.db")]: packages("qgis qgis-4.2.3-1.tar.bz2"),
  ...common(OSGEO4W),
  ...qgis(OSGEO4W, "qgis"),
  ...qgis(OSGEO4W, "qgis-ltr"),
  [win.join(OSGEO4W, "etc", "setup", "installed.db")]: packages(
    "qgis-common qgis-common-4.2.3-1.tar.bz2",
    "qgis qgis-4.2.3-1.tar.bz2",
    "qgis-ltr qgis-ltr-3.44.15-1.tar.bz2",
  ),
  ...common("D:\\软件\\QGIS 地理"),
  ...qgis("D:\\软件\\QGIS 地理", "qgis-ltr"),
  "C:\\Users\\张三\\数据\\点.geojson": "",
})

const install = (root: string, name: string, version: string | undefined) => ({
  ok: true,
  install: {
    app: win.join(root, "apps", name),
    interpreter: win.join(root, "bin", `python-${name}.bat`),
    version,
  },
})

test("a path is resolved to the QGIS it points at or into, as the disk spells it", async () => {
  const ltr = install(LTR, "qgis-ltr", "3.44.15")
  for (const configured of [
    LTR,
    `${LTR}\\`,
    `${LTR}\\bin`,
    `${LTR}\\bin\\python-qgis-ltr.bat`,
    `${LTR}\\bin\\qgis-ltr-bin.exe`,
    `${LTR}\\apps\\qgis-ltr\\python\\qgis`,
    `${LTR}\\apps\\Python312\\python.exe`,
    "c:/program files/qgis 3.44.15/BIN",
    "C:\\Program Files\\QGIS 3.44.15\\bin\\..\\etc",
  ]) {
    assert.deepEqual(await Windows.locate(configured, DISK), ltr, configured)
  }
  assert.deepEqual(await Windows.locate(`${CURRENT}\\bin\\qgis-bin.exe`, DISK), install(CURRENT, "qgis", "4.2.3"))
  // Without the package list there is no version until the check.
  assert.deepEqual(
    await Windows.locate("D:\\软件\\QGIS 地理", DISK),
    install("D:\\软件\\QGIS 地理", "qgis-ltr", undefined),
  )
})

test("a folder with more than one QGIS takes the one a path names, and otherwise asks", async () => {
  const current = install(OSGEO4W, "qgis", "4.2.3")
  const ltr = install(OSGEO4W, "qgis-ltr", "3.44.15")
  assert.deepEqual(await Windows.locate(`${OSGEO4W}\\apps\\qgis`, DISK), current)
  assert.deepEqual(await Windows.locate(`${OSGEO4W}\\bin\\qgis-bin.exe`, DISK), current)
  assert.deepEqual(await Windows.locate(`${OSGEO4W}\\bin\\python-qgis-ltr.bat`, DISK), ltr)
  assert.deepEqual(await Windows.locate(`${OSGEO4W}\\APPS\\QGIS-LTR\\bin`, DISK), ltr)
  // Windows drops the spaces and dots a name ends in.
  assert.deepEqual(await Windows.locate(`${OSGEO4W}\\apps\\qgis. `, DISK), current)
  for (const configured of [OSGEO4W, `${OSGEO4W}\\bin`, `${OSGEO4W}\\apps`, `${OSGEO4W}\\bin\\o4w_env.bat`]) {
    const located = await Windows.locate(configured, DISK)
    assert.deepEqual(
      located.ok ? located : [located.status, located.folder, located.choices],
      [
        "ambiguous",
        OSGEO4W,
        [
          { app: `${OSGEO4W}\\apps\\qgis`, version: "4.2.3" },
          { app: `${OSGEO4W}\\apps\\qgis-ltr`, version: "3.44.15" },
        ],
      ],
      configured,
    )
  }
})

test("each kind of wrong path settles on its own state", async () => {
  const status = async (configured: string, on = DISK) => {
    const located = await Windows.locate(configured, on)
    return located.ok ? "ok" : located.status
  }
  assert.equal(await status("Program Files\\QGIS 3.44.15"), "path-missing")
  assert.equal(await status("C:QGIS"), "path-missing")
  assert.equal(await status("C:\\Program Files\\QGIS 3.40.11"), "path-missing")
  assert.equal(await status("C:\\Users\\张三\\数据\\点.geojson"), "not-qgis")
  assert.equal(await status("C:\\Program Files"), "not-qgis")

  const root = "E:\\QGIS"
  // A QGIS whose launcher is gone, and one left beside another that can start.
  const launcherless = Object.entries({ ...common(root), ...qgis(root, "qgis-ltr") }).filter(
    ([file]) => !win.basename(file).startsWith("python-"),
  )
  const located = await Windows.locate(root, disk(Object.fromEntries(launcherless)))
  assert.deepEqual(located.ok ? located : [located.status, located.app], ["python-missing", `${root}\\apps\\qgis-ltr`])
  const leftover = disk({ ...common(root), ...qgis(root, "qgis"), [`${root}\\apps\\qgis-old\\bin\\qgis_core.dll`]: "" })
  assert.deepEqual(await Windows.locate(root, leftover), install(root, "qgis", undefined))
  assert.equal(await status(`${root}\\apps\\qgis-old`, leftover), "python-missing")
  // Launchers with no QGIS beside them.
  assert.equal(await status(root, disk({ [`${root}\\bin\\python-qgis.bat`]: "" })), "not-qgis")
  // A path that names a QGIS the folder does not hold is not taken for the one it does.
  const named = disk({ ...common(root), ...qgis(root, "qgis"), [`${root}\\bin\\python-qgis-dev.bat`]: "" })
  assert.equal(await status(`${root}\\bin\\python-qgis-dev.bat`, named), "not-qgis")
})

test("the QGIS installs are found where the installers put them, on every fixed drive, newest first", async () => {
  // A folder found again under another spelling is listed once, as the drive's listing spells it.
  const environment = { ProgramFiles: "c:\\program files", SystemDrive: "C:" }
  const everywhere = await Windows.installs(["C:\\", "D:\\"], DISK, environment)
  assert.deepEqual(everywhere, [
    { app: `${CURRENT}\\apps\\qgis`, version: "4.2.3" },
    { app: `${OSGEO4W}\\apps\\qgis`, version: "4.2.3" },
    { app: `${LTR}\\apps\\qgis-ltr`, version: "3.44.15" },
    { app: `${OSGEO4W}\\apps\\qgis-ltr`, version: "3.44.15" },
  ])
  // Without the drives, the system drive is looked at.
  assert.deepEqual(
    (await Windows.installs([], DISK, environment)).map((found) => found.app),
    [`${CURRENT}\\apps\\qgis`, `${LTR}\\apps\\qgis-ltr`],
  )
})

test("the fixed drives are read from PowerShell's answer", () => {
  assert.deepEqual(Windows.drives("C:\r\nd:\r\n\r\nWARNING: something\r\nE:\\data\r\n"), ["C:\\", "D:\\"])
  const { args } = Windows.drivesCommand()
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  assert.match(script, /DriveType=3/)
})
