import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import type { Protocol } from "../src/protocol.ts"
import { Environment } from "../src/python/index.ts"
import { Runtime } from "../src/runtime.ts"
import { Status } from "../src/status.ts"
import type { Transport } from "../src/transport.ts"

const posix = process.platform !== "win32"

/** The real interpreter behind `python3`, to stand in for the bundled one; none skips these tests. */
const python3 = (() => {
  if (!posix) return
  try {
    return (
      execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim() || undefined
    )
  } catch {
    return
  }
})()

const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** In order: a folder's listing is not in one on every file system. */
const listed = async (folder: string) => (await fs.readdir(folder)).sort()

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

/**
 * A bundle as scripts/stage-python.sh stages one, of an environment whose python3 runs the real one after noting its
 * arguments and environment in `calls.log`; it holds a file named for its id, to tell which bundle the base came from.
 */
const bundle = async (directory: string, id: string) => {
  const folder = path.join(directory, `bundle-${id}`)
  const tree = path.join(folder, "tree")
  await fs.mkdir(path.join(tree, "python", "bin"), { recursive: true })
  const interpreter = path.join(tree, "python", "bin", "python3")
  const log = path.join(directory, "calls.log")
  await fs.writeFile(interpreter, `#!/bin/sh\n{ echo "ARGS $*"; env; echo END; } >> '${log}'\nexec '${python3}' "$@"\n`)
  await fs.chmod(interpreter, 0o755)
  await fs.writeFile(path.join(tree, "python", `from-${id}`), id)
  execFileSync("tar", ["-czf", path.join(folder, "python.tar.gz"), "-C", tree, "python"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  await fs.writeFile(path.join(folder, "python.json"), JSON.stringify({ id, python: "3.13.16" }))
  return folder
}

const start = async (directory: string, bundled: string) => {
  const sent: Protocol.Outbound[] = []
  const transport: Transport = { send: (message) => void sent.push(structuredClone(message)), listen: () => () => {} }
  const layer = Layer.mergeAll(
    Runtime.layer(Engine.ledger(transport)),
    Status.layer,
    Config.layer(path.join(directory, "machine.json")),
  )
  const capability = Environment.capability({ bundle: bundled, data: path.join(directory, "data") })
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [capability])).pipe(Effect.provide(layer)))
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "python" ? [message.value as Environment.State] : [],
    )
  const settled = async () => {
    const pending = new Set(["checking", "preparing"])
    await until(() => !pending.has(states().at(-1)?.status ?? "checking"), 30000, "the environment to settle")
    return states().at(-1)!
  }
  return { states, settled, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) }
}

/** Starts the engine, waits for the environment to settle, and stops the engine. */
const settle = async (directory: string, bundled: string) => {
  const engine = await start(directory, bundled)
  try {
    return { last: await engine.settled(), states: engine.states() }
  } finally {
    await engine.stop()
  }
}

const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "geoengine-python-"))

const steps = (states: readonly Environment.State[]) =>
  states.flatMap((state) => (state.status === "preparing" ? [state.step] : []))

test(
  "a first start unpacks the bundled environment and makes the working one from it",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const { last, states } = await settle(directory, await bundle(directory, "one"))

      assert.deepEqual(last, { status: "ready", version: "3.13.16", python: where.envPython })
      assert.deepEqual([...new Set(steps(states))], ["unpacking", "creating"])
      assert.ok(await exists(path.join(where.base, "from-one")))
      assert.deepEqual(JSON.parse(await fs.readFile(where.marker, "utf-8")), { id: "one" })
      assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
      const inside = execFileSync(where.envPython, ["-c", "import sys; print(sys.prefix != sys.base_prefix)"], {
        encoding: "utf-8",
      })
      assert.equal(inside.trim(), "True")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "the Python is run isolated, with the network's variables and HOME of the engine's environment alone",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    process.env.https_proxy = "http://proxy.test:3128"
    process.env.GEOENGINE_TEST_USER_ONLY = "the user's"
    try {
      await settle(directory, await bundle(directory, "one"))
      const calls = (await fs.readFile(path.join(directory, "calls.log"), "utf-8")).split("END\n").filter(Boolean)
      assert.ok(calls.length > 0)
      for (const call of calls) {
        assert.match(call, /^ARGS -I -X utf8 /)
        assert.match(call, /^https_proxy=http:\/\/proxy\.test:3128$/m)
        assert.doesNotMatch(call, /GEOENGINE_TEST_USER_ONLY/)
        assert.ok(call.split("\n").includes(`HOME=${process.env.HOME}`))
      }
    } finally {
      delete process.env.https_proxy
      delete process.env.GEOENGINE_TEST_USER_ONLY
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "a later start with the same bundle unpacks nothing, and makes the working environment again only once it is gone",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const bundled = await bundle(directory, "one")
      await settle(directory, bundled)
      // A file of the base's own that unpacking would take away.
      await fs.writeFile(path.join(where.base, "kept"), "")

      const again = await settle(directory, bundled)
      assert.equal(again.last.status, "ready")
      assert.deepEqual(steps(again.states), [])

      await fs.rm(where.env, { recursive: true })
      const remade = await settle(directory, bundled)
      assert.equal(remade.last.status, "ready")
      assert.deepEqual([...new Set(steps(remade.states))], ["creating"])
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
    assert.deepEqual([...new Set(steps(states))], ["unpacking", "creating"])
    assert.ok(await exists(path.join(where.base, "from-two")))
    assert.ok(!(await exists(path.join(where.base, "from-one"))))
    assert.ok(!(await exists(path.join(where.env, "installed"))))
    assert.deepEqual(JSON.parse(await fs.readFile(where.marker, "utf-8")), { id: "two" })
    assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("an unpacking cut short is cleared away and done again", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    const bundled = await bundle(directory, "one")
    await settle(directory, bundled)
    // As a stop between moving the old base aside and writing the marker leaves it.
    await fs.mkdir(path.join(where.root, ".unpack-cut"))
    await fs.rename(where.base, path.join(where.root, ".unpack-cut", "replaced"))

    const { last, states } = await settle(directory, bundled)
    assert.equal(last.status, "ready")
    assert.ok(steps(states).includes("unpacking"))
    assert.ok(await exists(path.join(where.base, "from-one")))
    assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(
  "a bundle that cannot be unpacked fails, and the environment in place stays as it was",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const good = await bundle(directory, "one")
      await settle(directory, good)
      const broken = await bundle(directory, "two")
      await fs.writeFile(path.join(broken, "python.tar.gz"), "not an archive")

      const { last } = await settle(directory, broken)
      assert.equal(last.status, "failed")
      assert.equal(last.status === "failed" && last.diagnostics.step, "unpack")
      assert.ok(last.status === "failed" && last.diagnostics.output)
      assert.ok(await exists(path.join(where.base, "from-one")))
      assert.deepEqual(JSON.parse(await fs.readFile(where.marker, "utf-8")), { id: "one" })
      assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])

      // Guards against a failed unpacking having touched the base: its own bundle finds nothing to do.
      const back = await settle(directory, good)
      assert.equal(back.last.status, "ready")
      assert.deepEqual(steps(back.states), [])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "an unpacked environment that cannot take the base's place leaves the base where it was",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const good = await bundle(directory, "one")
      await settle(directory, good)
      // Unpacks cleanly, but into a folder of another name, so there is nothing to put in the base's place.
      const misnamed = await bundle(directory, "two")
      const tree = path.join(misnamed, "tree")
      await fs.rename(path.join(tree, "python"), path.join(tree, "elsewhere"))
      execFileSync("tar", ["-czf", path.join(misnamed, "python.tar.gz"), "-C", tree, "elsewhere"], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      })

      const { last } = await settle(directory, misnamed)
      assert.equal(last.status === "failed" && last.diagnostics.step, "unpack")
      assert.ok(await exists(path.join(where.base, "from-one")))
      assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
      assert.equal((await settle(directory, good)).last.status, "ready")
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
