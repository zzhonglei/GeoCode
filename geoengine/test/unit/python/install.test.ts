import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Environment } from "../../../src/python/index.ts"
import { python3, bundle, calls, exists, settle, steps, temporary } from "../../support/python.ts"

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
      // Guards against the loading screen naming another package than the one being imported.
      assert.deepEqual(
        states.find((state) => state.status === "preparing" && state.step === "warming"),
        { status: "preparing", step: "warming", name: "NumPy", number: 1, total: 12 },
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
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(
  "pixi-unpack has its temporary folder in the data directory, and nothing of the engine's environment",
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
