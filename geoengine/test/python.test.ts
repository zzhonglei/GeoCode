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

const executable = async (file: string, text: string) => {
  await fs.writeFile(file, text)
  await fs.chmod(file, 0o755)
}

/**
 * A bundle as scripts/stage-python.sh stages one. Its pixi-unpack unpacks the packed environment through its temporary
 * folder and leaves an activation script beside it, as the real one does; the environment's python3 runs the real one.
 * Both first note their arguments and environment in `calls.log`. The environment holds a file named for the bundle's
 * id, to tell which bundle the base came from, and files of the kinds installing takes away.
 */
const bundle = async (directory: string, id: string, options: { fails?: boolean } = {}) => {
  const folder = path.join(directory, `bundle-${id}`)
  const tree = path.join(folder, "tree", "python")
  const log = path.join(directory, "calls.log")
  for (const sub of ["bin", "include", path.join("lib", "python3.13", "site-packages")]) {
    await fs.mkdir(path.join(tree, sub), { recursive: true })
  }
  await executable(
    path.join(tree, "bin", "python3"),
    `#!/bin/sh\n{ echo "PYTHON $*"; env; echo END; } >> '${log}'\nexec '${python3}' "$@"\n`,
  )
  await fs.writeFile(path.join(tree, `from-${id}`), id)
  for (const file of [path.join("include", "Python.h"), path.join("lib", "libz.a"), path.join("lib", "libz.dylib")]) {
    await fs.writeFile(path.join(tree, file), "")
  }
  execFileSync("tar", ["-cf", path.join(folder, "python.tar"), "-C", path.dirname(tree), "python"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  await executable(
    path.join(folder, "pixi-unpack"),
    [
      "#!/bin/sh",
      `{ echo "UNPACK $*"; env; echo END; } >> '${log}'`,
      options.fails ? `echo "the packages could not be installed" >&2; exit 3` : "",
      "pack=$1; shift",
      "while [ $# -gt 0 ]; do case $1 in --output-directory) out=$2 ;; --env-name) name=$2 ;; esac; shift; done",
      'tar -xf "$pack" -C "$TMPDIR" && mv "$TMPDIR/python" "$out/$name" && echo "# activate" > "$out/activate.sh"',
    ].join("\n") + "\n",
  )
  await fs.writeFile(path.join(folder, "python.json"), JSON.stringify({ id, python: "3.13.16" }))
  return folder
}

/** What the bundle's programs noted, each with what ran it ("PYTHON" or "UNPACK"), its arguments and environment. */
const calls = async (directory: string) =>
  (await fs.readFile(path.join(directory, "calls.log"), "utf-8"))
    .split("END\n")
    .filter(Boolean)
    .map((call) => {
      const [first = "", ...lines] = call.split("\n").filter(Boolean)
      const [program = "", ...args] = first.split(" ")
      const env = new Map(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
      return { program, args, env }
    })

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
  "a first start installs the bundled environment and makes the working one from it",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      const { last, states } = await settle(directory, await bundle(directory, "one"))

      assert.deepEqual(last, { status: "ready", version: "3.13.16", python: where.envPython })
      assert.deepEqual([...new Set(steps(states))], ["installing", "creating"])
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

test(
  "the Python is run isolated, with the network's variables and HOME of the engine's environment alone",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    process.env.https_proxy = "http://proxy.test:3128"
    process.env.GDAL_DATA = "/the/user's/gdal"
    process.env.GEOENGINE_TEST_USER_ONLY = "the user's"
    try {
      await settle(directory, await bundle(directory, "one"))
      const pythons = (await calls(directory)).filter((call) => call.program === "PYTHON")
      assert.ok(pythons.length > 0)
      for (const { args, env } of pythons) {
        assert.deepEqual(args.slice(0, 3), ["-I", "-X", "utf8"])
        assert.equal(env.get("https_proxy"), "http://proxy.test:3128")
        assert.equal(env.get("HOME"), process.env.HOME)
        assert.ok(!env.has("GDAL_DATA"))
        assert.ok(!env.has("GEOENGINE_TEST_USER_ONLY"))
      }
    } finally {
      delete process.env.https_proxy
      delete process.env.GDAL_DATA
      delete process.env.GEOENGINE_TEST_USER_ONLY
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "every Python of the environment sets the environment's own variables as it starts, in place of the user's",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const site = path.join(where.stdlib("3.13.16"), "site-packages")
      // Guards against a Python started outside GeoEngine, as in GeoAgent's shell, finding its data by the user's
      // GDAL_DATA and PROJ_DATA, or not finding it at all.
      const names = [
        "GDAL_DATA",
        "GDAL_DRIVER_PATH",
        "PROJ_DATA",
        "PROJ_NETWORK",
        "PROJ_USER_WRITABLE_DIRECTORY",
        "GDAL_CONFIG_FILE",
      ]
      const script = [
        "import json, os, site, sys",
        `site.addsitedir(${JSON.stringify(site)})`,
        `print(json.dumps([sys.base_prefix, {name: os.environ.get(name) for name in ${JSON.stringify(names)}}]))`,
      ].join("\n")
      const output = execFileSync(python3!, ["-I", "-c", script], {
        encoding: "utf-8",
        env: Object.fromEntries(names.map((name) => [name, "the user's"])),
      })
      const [base, variables] = JSON.parse(output) as [string, Record<string, string>]
      assert.deepEqual(variables, {
        GDAL_DATA: path.join(base, "share", "gdal"),
        GDAL_DRIVER_PATH: path.join(base, "lib", "gdalplugins"),
        PROJ_DATA: path.join(base, "share", "proj"),
        PROJ_NETWORK: "ON",
        PROJ_USER_WRITABLE_DIRECTORY: path.join(path.dirname(base), "proj"),
        GDAL_CONFIG_FILE: path.join(base, "gdalrc"),
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  "on Windows the environment's folders come first in PATH, and its certificates stand in for the user's empty ones",
  { skip: !python3 },
  async () => {
    const directory = await temporary()
    try {
      const where = Environment.layout(path.join(directory, "data"))
      await settle(directory, await bundle(directory, "one"))
      const module = path.join(where.stdlib("3.13.16"), "site-packages", "_geocode_environment.py")
      // The written module run as on Windows: Windows's paths, and a base of its own.
      const base = "C:\\Users\\me\\.local\\share\\geocode\\python\\base"
      const script = [
        "import json, ntpath, os, sys",
        'sys.platform = "win32"',
        "os.path = ntpath",
        'os.pathsep = ";"',
        `sys.base_prefix = ${JSON.stringify(base)}`,
        `exec(open(${JSON.stringify(module)}, encoding="utf-8").read(), {"__name__": "_geocode_environment"})`,
        'print(json.dumps({name: os.environ.get(name) for name in ["PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"]}))',
      ].join("\n")
      const library = path.win32.join(base, "Library")
      const user = "C:\\Program Files\\QGIS\\bin"
      const output = execFileSync(python3!, ["-I", "-c", script], {
        encoding: "utf-8",
        // The base already in PATH, as a Python started from another of the environment leaves it.
        env: { PATH: [base, user].join(";"), SSL_CERT_FILE: "", SSL_CERT_DIR: "C:\\the user's\\certs" },
      })
      assert.deepEqual(JSON.parse(output), {
        PATH: [
          base,
          path.win32.join(library, "mingw-w64", "bin"),
          path.win32.join(library, "usr", "bin"),
          path.win32.join(library, "bin"),
          path.win32.join(base, "Scripts"),
          path.win32.join(base, "bin"),
          user,
        ].join(";"),
        SSL_CERT_FILE: path.win32.join(library, "ssl", "cacert.pem"),
        SSL_CERT_DIR: "C:\\the user's\\certs",
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)

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
    assert.deepEqual([...new Set(steps(states))], ["installing", "creating"])
    assert.ok(await exists(path.join(where.base, "from-two")))
    assert.ok(!(await exists(path.join(where.base, "from-one"))))
    assert.ok(!(await exists(path.join(where.env, "installed"))))
    assert.equal(JSON.parse(await fs.readFile(where.marker, "utf-8")).id, "two")
    assert.deepEqual(await listed(where.root), ["base", "base.json", "envs"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a base environment another GeoCode wrote its own files into is installed again", { skip: !python3 }, async () => {
  const directory = await temporary()
  try {
    const where = Environment.layout(path.join(directory, "data"))
    const bundled = await bundle(directory, "one")
    await settle(directory, bundled)
    // As a GeoCode with another startup file leaves it.
    const marker = JSON.parse(await fs.readFile(where.marker, "utf-8"))
    await fs.writeFile(where.marker, JSON.stringify({ ...marker, written: "an older GeoCode's" }))

    const { last, states } = await settle(directory, bundled)
    assert.equal(last.status, "ready")
    assert.deepEqual([...new Set(steps(states))], ["installing", "creating"])
    assert.deepEqual(JSON.parse(await fs.readFile(where.marker, "utf-8")), marker)

    // As a GeoCode that wrote no startup file leaves it.
    await fs.writeFile(where.marker, JSON.stringify({ id: marker.id }))
    const older = await settle(directory, bundled)
    assert.deepEqual([...new Set(steps(older.states))], ["installing", "creating"])
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
