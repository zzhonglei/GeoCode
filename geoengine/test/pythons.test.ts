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

/**
 * A prefix as installers lay one out, with earthengine-api and the packages named in its site-packages, each with the
 * installation record of its version when `versions` gives one.
 */
const prefix = async (
  root: string,
  site: string,
  python: readonly string[],
  packages: {
    readonly earthengine?: string
    readonly others?: readonly string[]
    readonly versions?: Readonly<Record<string, string>>
  },
) => {
  for (const file of python) await touch(path.join(root, file))
  if (packages.earthengine === undefined) return
  await touch(path.join(root, site, "ee", "__init__.py"))
  await fs.mkdir(path.join(root, site, `earthengine_api-${packages.earthengine}.dist-info`), { recursive: true })
  for (const module of packages.others ?? []) {
    await touch(path.join(root, site, module, "__init__.py"))
    const version = packages.versions?.[module]
    if (version) await fs.mkdir(path.join(root, site, `${module}-${version}.dist-info`), { recursive: true })
  }
}

const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "geoengine-pythons-"))

// Guards against listing a Python without earthengine-api, a conda environment twice, or one Python of Homebrew's for
// several, against a conda environment named by an interpreter other than the one users configure, and against a
// package too old for GeoCode looking fit until it is chosen.
test("finds the Pythons with earthengine-api from their folders, with versions and what is missing or too old", async () => {
  const root = await temporary()
  try {
    const env = path.join(root, "conda", "envs", "map")
    await prefix(env, "lib/python3.11/site-packages", ["bin/python", "bin/python3.11"], {
      earthengine: "1.7.19",
      others: ["geedim", "geopandas"],
      versions: { geedim: "2.0.0", geopandas: "1.0.1" },
    })
    // pip's record of the geedim conda replaced.
    await fs.mkdir(path.join(env, "lib/python3.11/site-packages", "geedim-1.9.1.dist-info"))
    await touch(path.join(env, "conda-meta", "python-3.11.15-h9ccd52b_0_cpython.json"))
    await fs.symlink("python3.11", path.join(env, "lib", "python3.1"))
    const bare = path.join(root, "conda", "envs", "bare")
    await prefix(bare, "lib/python3.12/site-packages", ["bin/python"], {})
    const brew = path.join(root, "homebrew")
    await prefix(brew, "lib/python3.12/site-packages", ["bin/python3", "bin/python3.12"], {
      earthengine: "1.5.0",
      others: ["geedim"],
      versions: { geedim: "1.9.1" },
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
        outdated: [{ package: "geedim", version: "1.9.1" }],
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
