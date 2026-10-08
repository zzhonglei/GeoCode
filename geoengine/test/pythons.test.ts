import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Pythons } from "../src/gee/pythons.ts"

const touch = async (file: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "")
}

/** A prefix as installers lay one out, with earthengine-api and the packages named in its site-packages. */
const prefix = async (
  root: string,
  site: string,
  python: readonly string[],
  packages: { readonly earthengine?: string; readonly others?: readonly string[] },
) => {
  for (const file of python) await touch(path.join(root, file))
  if (packages.earthengine === undefined) return
  await touch(path.join(root, site, "ee", "__init__.py"))
  await fs.mkdir(path.join(root, site, `earthengine_api-${packages.earthengine}.dist-info`), { recursive: true })
  for (const module of packages.others ?? []) await touch(path.join(root, site, module, "__init__.py"))
}

const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "geoengine-pythons-"))

/** Runs `body` with `home` as the user's home folder, on every system. */
const atHome = async (home: string, body: () => Promise<void>) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await body()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// Guards against listing a Python without earthengine-api, a conda environment twice, or one Python of Homebrew's for
// several, and against a conda environment named by an interpreter other than the one users configure.
test("finds the Pythons with earthengine-api from their folders, with versions and what is missing", async () => {
  const root = await temporary()
  try {
    const env = path.join(root, "conda", "envs", "map")
    await prefix(env, "lib/python3.11/site-packages", ["bin/python", "bin/python3.11"], {
      earthengine: "1.7.19",
      others: ["geedim", "geopandas"],
    })
    await touch(path.join(env, "conda-meta", "python-3.11.15-h9ccd52b_0_cpython.json"))
    await fs.symlink("python3.11", path.join(env, "lib", "python3.1"))
    const bare = path.join(root, "conda", "envs", "bare")
    await prefix(bare, "lib/python3.12/site-packages", ["bin/python"], {})
    const brew = path.join(root, "homebrew")
    await prefix(brew, "lib/python3.12/site-packages", ["bin/python3", "bin/python3.12"], {
      earthengine: "1.5.0",
      others: ["geedim"],
    })
    await prefix(brew, "lib/python3.13/site-packages", ["bin/python3.13"], { earthengine: "1.6.0" })

    const found = await Pythons.discover(
      [
        { prefix: env, name: "map" },
        { prefix: bare, name: "bare" },
        { prefix: brew, name: "Homebrew" },
        { prefix: env, name: "map" },
      ],
      "darwin",
    )
    assert.deepEqual(found, [
      { python: path.join(env, "bin", "python"), name: "map", version: "3.11.15", earthengine: "1.7.19", missing: [] },
      {
        python: path.join(brew, "bin", "python3.12"),
        name: "Homebrew",
        version: "3.12",
        earthengine: "1.5.0",
        missing: ["geopandas"],
      },
      {
        python: path.join(brew, "bin", "python3.13"),
        name: "Homebrew",
        version: "3.13",
        earthengine: "1.6.0",
        missing: ["geedim", "geopandas"],
      },
    ])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Guards against missing earthengine-api installed with pip's --user, as Apple's Python and Homebrew's lead users to.
test("counts the packages in the user's own site-packages for an installation that reads it", async () => {
  const root = await temporary()
  try {
    const framework = path.join(root, "Versions", "3.9")
    await prefix(framework, "lib/python3.9/site-packages", ["bin/python3"], {})
    await fs.mkdir(path.join(framework, "lib", "python3.9", "site-packages"), { recursive: true })
    const user = path.join(root, "user", "3.9", "site-packages")
    await prefix(user, "", [], { earthengine: "1.4.0", others: ["geopandas"] })
    const userSite = (version: string) => path.join(root, "user", version, "site-packages")
    const found = await Pythons.discover([{ prefix: framework, name: "macOS", userSite }], "darwin")
    assert.deepEqual(found, [
      {
        python: path.join(framework, "bin", "python3"),
        name: "macOS",
        version: "3.9",
        earthengine: "1.4.0",
        missing: ["geedim"],
      },
    ])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Guards against missing Windows installations, whose interpreter is at the root, or in Scripts for an environment.
test("reads Windows layouts: an installation's interpreter at its root, a virtual environment's in Scripts", async () => {
  const root = await temporary()
  try {
    const install = path.join(root, "Python311")
    await prefix(install, path.join("Lib", "site-packages"), ["python.exe", "python311.dll"], { earthengine: "1.7.19" })
    const venv = path.join(root, "venv")
    await prefix(venv, path.join("Lib", "site-packages"), [path.join("Scripts", "python.exe")], {
      earthengine: "1.7.0",
    })
    await fs.writeFile(path.join(venv, "pyvenv.cfg"), "home = C:\\Python312\nversion = 3.12.4\n")
    const found = await Pythons.discover(
      [
        { prefix: install, name: "Python.org" },
        { prefix: venv, name: "venv" },
      ],
      "win32",
    )
    assert.deepEqual(
      found.map((python) => [python.python, python.version]),
      [
        [path.join(install, "python.exe"), "3.11"],
        [path.join(venv, "Scripts", "python.exe"), "3.12.4"],
      ],
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Guards against missing the environments conda keeps outside its own folders, which only its list names, and against
// calling one made with --prefix "base" beside the real one.
test("looks in every environment conda lists, named as conda names them", async () => {
  const home = await temporary()
  await atHome(home, async () => {
    const base = path.join(home, "tools", "miniforge")
    await touch(path.join(base, "condabin", "conda"))
    const named = path.join(home, "work", "envs", "remote-sensing")
    const anywhere = path.join(home, "projects", "gee-env")
    await touch(path.join(home, ".conda", "environments.txt"))
    await fs.writeFile(
      path.join(home, ".conda", "environments.txt"),
      `${base}\n${named}\n${anywhere}\n\nrelative/env\n`,
    )
    const places = await Pythons.places("darwin", {})
    assert.deepEqual(
      places.slice(0, 3).map((place) => ({ prefix: place.prefix, name: place.name })),
      [
        { prefix: base, name: "base" },
        { prefix: named, name: "remote-sensing" },
        { prefix: anywhere, name: "gee-env" },
      ],
    )
    assert.ok(!places.some((place) => place.prefix === "relative/env"))
  })
  await fs.rm(home, { recursive: true, force: true })
})

// Guards against the configured Python showing twice when it is named by a link to an interpreter the scan found.
test("marks the configured Python by the file it is", async () => {
  const root = await temporary()
  try {
    const python = path.join(root, "bin", "python3.11")
    await touch(python)
    const link = path.join(root, "bin", "python")
    await fs.symlink("python3.11", link)
    const found = [
      { python: link, name: "map", missing: [] },
      { python: path.join(root, "other"), name: "x", missing: [] },
    ]
    const marked = await Pythons.mark(found, python)
    assert.deepEqual(
      marked.map((each) => each.configured),
      [true, undefined],
    )
    // Guards against a virtual environment, whose interpreter links to the Python it was made from, marking that one.
    const venv = path.join(root, "venv")
    await touch(path.join(venv, "pyvenv.cfg"))
    await fs.mkdir(path.join(venv, "bin"))
    await fs.symlink(python, path.join(venv, "bin", "python"))
    const withVenv = [...found, { python: path.join(venv, "bin", "python"), name: "venv", missing: [] }]
    assert.deepEqual(
      (await Pythons.mark(withVenv, path.join(venv, "bin", "python"))).map((each) => each.configured),
      [undefined, undefined, true],
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Guards against a virtual environment chosen by its folder resolving to the Python it was made from.
test("finds an environment's Python in its folder or a project's .venv, by the path that names it there", async () => {
  const root = await temporary()
  try {
    const base = path.join(root, "base", "python3.12")
    await touch(base)
    const venv = path.join(root, "project", ".venv", "bin", "python")
    await fs.mkdir(path.dirname(venv), { recursive: true })
    await fs.symlink(base, venv)
    assert.equal(await Pythons.interpreterIn(path.join(root, "project"), "darwin"), venv)
    assert.equal(await Pythons.interpreterIn(path.join(root, "project", ".venv"), "darwin"), venv)
    assert.equal(await Pythons.interpreterIn(path.join(root, "nothing"), "darwin"), undefined)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
