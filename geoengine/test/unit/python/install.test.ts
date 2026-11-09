import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Environment } from "../../../src/python/index.ts"
import { python3 } from "../../support/common.ts"
import { PACKAGES, bundle, calls, exists, settle, steps, temporary } from "../../support/python.ts"

/** In order: a folder's listing is not in one on every file system. */
const listed = async (folder: string) => (await fs.readdir(folder)).sort()

test(
  "a first start installs the bundled environment and makes the working one from it",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const { last, states } = await settle(directory, await bundle(directory, "one"))

      assert.deepEqual(last, { status: "ready", version: "3.13.16", python: where.envPython, base: where.basePython })
      assert.deepEqual([...new Set(steps(states))], ["installing", "creating", "warming"])
      // Guards against the loading screen's warm-up count skipping an import, running past its total or standing still.
      const warming = states.flatMap((state) =>
        state.status === "preparing" && state.step === "warming" ? [[state.done, state.total]] : [],
      )
      assert.deepEqual(
        warming,
        Array.from({ length: 13 }, (_, done) => [done, 12]),
      )
      assert.ok(await exists(path.join(where.base, "from-one")))
      assert.equal(JSON.parse(await fs.readFile(where.marker, "utf-8")).id, "one")
      // Without pixi-unpack's activation script and temporary folder.
      assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
      assert.match(
        await fs.readFile(path.join(where.base, "lib", "python3.13", "EXTERNALLY-MANAGED"), "utf-8"),
        /^\[externally-managed\]\n/,
      )
      assert.ok(!(await exists(path.join(where.base, "include"))))
      assert.deepEqual(await listed(path.join(where.base, "lib")), ["libz.dylib", "python3.13"])
      const inside = execFileSync(where.envPython, ["-c", "import sys; print(sys.prefix != sys.base_prefix)"], {
        encoding: "utf-8",
      })
      assert.equal(inside.trim(), "True")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("the environment is ready only once the base interpreter has warmed it up", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    await settle(directory, await bundle(directory, "one", { slowWarm: true }))
    // Guards against calling the environment ready before the warm-up is over, or warming it up through the working
    // environment.
    assert.ok(await exists(path.join(directory, "warmed")))
    // Guards against importing one package after another, which waits out macOS's first check of each library in turn,
    // or all at once, which takes the memory of every import together.
    const overlap = (await fs.readFile(path.join(directory, "overlap"), "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map(Number)
    assert.equal(overlap.length, 12)
    assert.ok(Math.max(...overlap) > 1 && Math.max(...overlap) <= 6, JSON.stringify(overlap))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(
  "the loading screen counts the packages as pixi-unpack unpacks and installs them",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const { states } = await settle(directory, await bundle(directory, "one", { gradual: true }))
      const counts = states.flatMap((state) =>
        state.status === "preparing" && state.step === "installing" ? [[state.done, state.total]] : [],
      )
      // Guards against a count that stands still through the install, goes back when pixi-unpack empties its temporary
      // folder, or runs past the bundle's packages.
      assert.ok(
        counts.every(([, total]) => total === PACKAGES),
        JSON.stringify(counts),
      )
      const done = counts.map(([count]) => count)
      assert.deepEqual(
        done,
        [...done].sort((a, b) => a - b),
        JSON.stringify(counts),
      )
      assert.equal(done[0], 0)
      assert.ok(
        done.some((count) => count > 0 && count < PACKAGES),
        JSON.stringify(counts),
      )
      assert.ok(done.at(-1)! >= PACKAGES - 1, JSON.stringify(counts))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "pixi-unpack has its temporary folder in the data directory, and none of the user's variables",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    process.env.GEOENGINE_TEST_USER_ONLY = "the user's"
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const unpack = (await calls(directory)).find((call) => call.program === "UNPACK")
      assert.ok(unpack)
      assert.equal(path.dirname(unpack.env.get("TMPDIR") ?? ""), where.root)
      assert.match(path.basename(unpack.env.get("TMPDIR") ?? ""), /^\.unpack-/)
      assert.ok(!unpack.env.has("GEOENGINE_TEST_USER_ONLY"))
    } finally {
      delete process.env.GEOENGINE_TEST_USER_ONLY
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "a later start with the same bundle installs nothing, and makes the working environment again only once it is gone",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const bundled = await bundle(directory, "one")
      await settle(directory, bundled)
      // A file of the base's own that installing would take away.
      await fs.writeFile(path.join(where.base, "kept"), "")

      const again = await settle(directory, bundled)
      assert.equal(again.last.status, "ready")
      assert.deepEqual(steps(again.states), [])

      await fs.rm(where.env, { recursive: true })
      const remade = await settle(directory, bundled)
      assert.equal(remade.last.status, "ready")
      assert.deepEqual([...new Set(steps(remade.states))], ["creating", "warming"])
      assert.ok(await exists(where.envPython))
      assert.ok(await exists(path.join(where.base, "kept")))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("a working environment whose making was cut short is made again", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    const bundled = await bundle(directory, "one")
    await settle(directory, bundled)
    // As venv leaves one stopped before its last step: the interpreter there, the base's packages not yet seen.
    const config = path.join(where.env, "pyvenv.cfg")
    await fs.writeFile(
      config,
      (await fs.readFile(config, "utf-8")).replace(
        "include-system-site-packages = true",
        "include-system-site-packages = false",
      ),
    )

    const { last, states } = await settle(directory, bundled)
    assert.equal(last.status, "ready")
    assert.deepEqual([...new Set(steps(states))], ["creating", "warming"])
    // Guards against handing GeoAgent a working environment that imports none of the preinstalled packages.
    const seen = execFileSync(
      where.envPython,
      ["-c", "import site, sys; print(any(p.startswith(sys.base_prefix) for p in site.getsitepackages()))"],
      { encoding: "utf-8" },
    )
    assert.equal(seen.trim(), "True")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a new bundle replaces the base environment and the working one made from it", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    await settle(directory, await bundle(directory, "one"))
    await fs.writeFile(path.join(where.env, "installed"), "")

    const { last, states } = await settle(directory, await bundle(directory, "two"))
    assert.equal(last.status, "ready")
    assert.deepEqual([...new Set(steps(states))], ["installing", "creating", "warming"])
    assert.ok(await exists(path.join(where.base, "from-two")))
    assert.ok(!(await exists(path.join(where.base, "from-one"))))
    assert.ok(!(await exists(path.join(where.env, "installed"))))
    assert.equal(JSON.parse(await fs.readFile(where.marker, "utf-8")).id, "two")
    assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("an installation cut short is cleared away and done again", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    const bundled = await bundle(directory, "one")
    await settle(directory, bundled)
    // As a stop before the marker is written leaves it: no marker, pixi-unpack's leftovers beside the base.
    await fs.rm(where.marker)
    await fs.mkdir(path.join(where.root, ".unpack-cut", "cache"), { recursive: true })
    await fs.writeFile(path.join(where.root, "activate.sh"), "")

    const { last, states } = await settle(directory, bundled)
    assert.equal(last.status, "ready")
    assert.ok(steps(states).includes("installing"))
    assert.ok(await exists(path.join(where.base, "from-one")))
    assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(
  "an installation that fails says so, and leaves nothing that a later start would use",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const good = await bundle(directory, "one")
      await settle(directory, good)
      // An earlier installation's leftover, which a failing one does not get as far as removing.
      await fs.writeFile(path.join(where.root, "activate.sh"), "")

      const { last } = await settle(directory, await bundle(directory, "two", { fails: true }))
      assert.equal(last.status, "failed")
      assert.equal(last.status === "failed" && last.diagnostics.step, "install")
      assert.match((last.status === "failed" && last.diagnostics.output) || "", /could not be installed/)
      // No marker, base or leftovers: only the empty folder the working environment was in.
      assert.deepEqual(await listed(where.root), ["envs"])

      const back = await settle(directory, good)
      assert.equal(back.last.status, "ready")
      assert.ok(steps(back.states).includes("installing"))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test("a missing bundle fails, and leaves the data directory alone", async () => {
  const directory = await temporary()
  try {
    const { last } = await settle(directory, path.join(directory, "nowhere"))
    assert.equal(last.status, "failed")
    assert.equal(last.status === "failed" && last.diagnostics.step, "bundle")
    assert.ok(!(await exists(path.join(directory, "data"))))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
