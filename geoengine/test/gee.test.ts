import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import { Gee } from "../src/gee/index.ts"
import { Python } from "../src/gee/python.ts"
import type { Protocol } from "../src/protocol.ts"
import { Runtime } from "../src/runtime.ts"
import { Status } from "../src/status.ts"
import type { Transport } from "../src/transport.ts"

const posix = process.platform !== "win32"

/** A Python 3 to run the real scripts with, or none, which skips the tests that need one. */
const python3 = (() => {
  if (!posix) return
  try {
    return execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf-8" }).trim() || undefined
  } catch {
    return
  }
})()

/**
 * Stands in for earthengine-api and requests, so the real scripts run without a network: a request sends nothing and
 * waits as long as it is given; a project named "refused" is refused, as Earth Engine refuses one not registered.
 */
const STUBS = {
  "requests/__init__.py": `import time


class Session:
    def send(self, prepared, **options):
        time.sleep(prepared or 0)
        return "sent"
`,
  "ee/__init__.py": `import os

import requests

__version__ = "1.7.19"


def Initialize(project=None):
    print("*** Earth Engine *** Share your feedback")
    # The file stands for a project refused after the check passed; the check does not run in the session's folder.
    if project == "refused" or os.path.exists("refuse"):
        raise Exception("Caller does not have required permission to use project %s" % project)


def wait(seconds):
    return requests.Session().send(seconds)


class Number:
    def __init__(self, value):
        self.value = value

    def getInfo(self):
        wait(0)
        return self.value
`,
}

/** A shell script standing in for the configured Python; `body` reads the program from stdin as Python would. */
const fakePython = async (directory: string, body: string, name = "python") => {
  const file = path.join(directory, name)
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`)
  await fs.chmod(file, 0o755)
  return file
}

/** The real Python 3 with the stubs first on its path. */
const stubbedPython = async (directory: string) => {
  const stubs = path.join(directory, "stubs")
  for (const [name, text] of Object.entries(STUBS)) {
    await fs.mkdir(path.dirname(path.join(stubs, name)), { recursive: true })
    await fs.writeFile(path.join(stubs, name), text)
  }
  return fakePython(directory, `PYTHONPATH='${stubs}' exec '${python3}' "$@"`)
}

const mark = (payload: unknown) => `cat >/dev/null; echo '${Python.MARKER}${JSON.stringify(payload)}'`

type Response = Extract<Protocol.Outbound, { type: "response" }>
type Progress = Extract<Protocol.Outbound, { type: "progress" }>

const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const start = async (block?: (directory: string) => Promise<unknown>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-gee-"))
  const machine = path.join(directory, "machine.json")
  if (block) await fs.writeFile(machine, JSON.stringify({ gee: await block(directory) }))
  const sent: Protocol.Outbound[] = []
  let deliver: (message: unknown) => void = () => {}
  const transport: Transport = {
    send: (message) => void sent.push(structuredClone(message)),
    listen: (handler) => {
      deliver = handler
      return () => {}
    },
  }
  const layer = Layer.mergeAll(Runtime.layer(Engine.ledger(transport)), Status.layer, Config.layer(machine))
  const fiber = Effect.runFork(Effect.scoped(Engine.run(transport, [Gee.capability])).pipe(Effect.provide(layer)))
  const states = () =>
    sent.flatMap((message) =>
      message.type === "status" && message.domain === "gee" ? [message.value as Gee.State] : [],
    )
  const settled = async (ms = 10000) => {
    await until(() => (states().at(-1)?.status ?? "checking") !== "checking", ms, "GEE to settle")
    return states().at(-1)!
  }
  let nextId = 0
  const send = (params: unknown, method = "gee.run") => {
    nextId += 1
    deliver({ type: "request", id: nextId, method, params })
    return nextId
  }
  const response = async (id: number, ms = 20000) => {
    const find = () => sent.find((message): message is Response => message.type === "response" && message.id === id)
    await until(() => find() !== undefined, ms, `the response to ${id}`)
    return find()!
  }
  const progress = (id: number) =>
    sent.flatMap((message) => (message.type === "progress" && message.id === id ? [(message as Progress).data] : []))
  const stop = async () => {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    await until(() => sent.some((message) => message.type === "ready"), 10000, "the engine")
  } catch (error) {
    await stop()
    throw error
  }
  return { directory, machine, states, settled, send, response, progress, deliver: (m: unknown) => deliver(m), stop }
}

const result = (response: Response) => {
  assert.ok(response.ok, JSON.stringify(response))
  return response.result as { outcome: string; output: string; truncated: boolean; durationMs: number; exit?: string }
}

test("no configuration settles on unconfigured, and a run is refused with what to do", async () => {
  const engine = await start()
  try {
    assert.equal((await engine.settled()).status, "unconfigured")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.match(!response.ok ? response.error.message : "", /"gee" block of .*machine\.json/)
    assert.match(!response.ok ? response.error.message : "", /never guess it/)
  } finally {
    await engine.stop()
  }
})

test("each finding of the check settles on its own state", { skip: !posix }, async () => {
  const cases: [(directory: string) => Promise<unknown>, string][] = [
    [async (directory) => ({ python: path.join(directory, "missing", "python"), project: "p" }), "python-missing"],
    [
      async (directory) => ({
        python: await fakePython(
          directory,
          mark({ python: "3.12.1", failed: "import", error: "ModuleNotFoundError: No module named 'ee'" }),
        ),
        project: "p",
      }),
      "packages-missing",
    ],
    [
      async (directory) => ({ python: await fakePython(directory, mark({ python: "3.12.1", ee: "1.7.19" })) }),
      "project-missing",
    ],
    [
      async (directory) => ({
        python: await fakePython(
          directory,
          mark({ python: "3.12.1", ee: "1.7.19", failed: "earthengine", error: "EEException: Not signed up" }),
        ),
        project: "p",
      }),
      "check-failed",
    ],
    // Guards against a Python that ends without a report reading as anything but a failed check, losing its output.
    [
      async (directory) => ({
        python: await fakePython(directory, "echo 'Segmentation fault' >&2; exit 139"),
        project: "p",
      }),
      "check-failed",
    ],
    [
      async (directory) => ({
        python: await fakePython(directory, mark({ python: "3.12.1", ee: "1.7.19" })),
        project: "p",
      }),
      "ready",
    ],
  ]
  for (const [block, expected] of cases) {
    const engine = await start(block)
    try {
      const state = await engine.settled()
      assert.equal(state.status, expected, JSON.stringify(state))
    } finally {
      await engine.stop()
    }
  }
})

// Guards against GeoAgent being told only that the check ended without a report, not what the Python said.
test("a Python that ends without a report is described by what it printed", { skip: !posix }, async () => {
  const engine = await start(async (directory) => ({
    python: await fakePython(directory, "cat >/dev/null; echo 'Python was not found' >&2; exit 9"),
  }))
  try {
    const state = await engine.settled()
    assert.equal(state.status, "check-failed")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    const message = !response.ok ? response.error.message : ""
    assert.match(message, /exited with code 9 without a report\nPython was not found\n/)
    // Guards against naming a project that is not configured.
    assert.doesNotMatch(message, /undefined/)
  } finally {
    await engine.stop()
  }
})

// Guards against a call waiting out the settle limit for a check nothing starts, when the file has not changed.
test("a run without a project is refused at once with what to do", { skip: !posix }, async () => {
  const engine = await start(async (directory) => ({
    python: await fakePython(directory, mark({ python: "3.12.1", ee: "1.7.19" })),
  }))
  try {
    assert.equal((await engine.settled()).status, "project-missing")
    const started = Date.now()
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.ok(Date.now() - started < 5000, `answered after ${Date.now() - started} ms`)
    assert.equal(!response.ok && response.error.code, "not-ready")
    assert.match(!response.ok ? response.error.message : "", /No Google Cloud project is configured/)
  } finally {
    await engine.stop()
  }
})

test(
  "the check hands the project to the Python, and a refusal reads as a failed check",
  { skip: !python3 },
  async () => {
    for (const [project, expected] of [
      ["majestic", "ready"],
      ["refused", "check-failed"],
    ] as const) {
      const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project }))
      try {
        const state = await engine.settled()
        assert.equal(state.status, expected, JSON.stringify(state))
        if (state.status === "ready") assert.deepEqual(state.versions.ee, "1.7.19")
        if (state.status === "check-failed")
          assert.match(state.diagnostics.message, /required permission to use project refused/)
      } finally {
        await engine.stop()
      }
    }
  },
)

test("a project written after the Python is configured is seen by the next run", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory) }))
  try {
    const state = await engine.settled()
    assert.equal(state.status, "project-missing")
    const python = (JSON.parse(await fs.readFile(engine.machine, "utf-8")) as { gee: { python: string } }).gee.python
    await fs.writeFile(engine.machine, JSON.stringify({ gee: { python, project: "majestic" } }))
    // At once, within the watch's debounce: the run reads the file again itself.
    const done = result(
      await engine.response(engine.send({ script: "print(ee.Number(7).getInfo())", cwd: engine.directory })),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "7\n")
  } finally {
    await engine.stop()
  }
})

test(
  "a run hands GeoAgent what the script printed, and nothing printed before it began",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      const script =
        'import os\nprint("中文", os.getcwd())\nprint(ee.Number(1).getInfo())\nimport sys\nprint("warned", file=sys.stderr)'
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id))
      assert.equal(done.outcome, "finished")
      const cwd = await fs.realpath(engine.directory)
      assert.equal(done.output, `中文 ${cwd}\n1\nwarned\n`)
      assert.doesNotMatch(done.output, /Earth Engine|__GEOCODE_GEE__/)
      assert.deepEqual(engine.progress(id), [{ begun: true }])
    } finally {
      await engine.stop()
    }
  },
)

test("a failing script ends with its traceback, from its own lines", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const done = result(
      await engine.response(engine.send({ script: 'print("before")\nvalue = 1 / 0\n', cwd: engine.directory })),
    )
    assert.equal(done.outcome, "failed")
    assert.match(
      done.output,
      /^before\nTraceback \(most recent call last\):\n {2}File "<script>", line 2, in <module>\n {4}value = 1 \/ 0\n/,
    )
    assert.match(done.output, /ZeroDivisionError/)
    assert.doesNotMatch(done.output, /<stdin>/)

    const exited = result(
      await engine.response(engine.send({ script: "import sys\nsys.exit(3)", cwd: engine.directory })),
    )
    assert.equal(exited.outcome, "failed")
    const syntax = result(await engine.response(engine.send({ script: "print(", cwd: engine.directory })))
    assert.equal(syntax.outcome, "failed")
    assert.match(syntax.output, /SyntaxError/)
  } finally {
    await engine.stop()
  }
})

test("a script file runs from its own folder's imports, and a missing one is refused", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const folder = path.join(engine.directory, "脚本")
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, "helper.py"), "VALUE = 42\n")
    await fs.writeFile(
      path.join(folder, "main.py"),
      "import sys\nfrom helper import VALUE\nprint(VALUE, sys.argv[0] == __file__)\n",
    )
    const done = result(
      await engine.response(engine.send({ file: path.join(folder, "main.py"), cwd: engine.directory })),
    )
    assert.equal(done.outcome, "finished")
    assert.equal(done.output, "42 True\n")

    const missing = await engine.response(engine.send({ file: path.join(folder, "none.py"), cwd: engine.directory }))
    assert.equal(!missing.ok && missing.error.code, "invalid-params")
    const neither = await engine.response(engine.send({ cwd: engine.directory }))
    assert.equal(!neither.ok && neither.error.code, "invalid-params")
  } finally {
    await engine.stop()
  }
})

test(
  "a file in the session's folder named like a module the run needs does not replace it, and the script runs as __main__",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      for (const name of ["json.py", "requests.py", "ee.py"]) {
        await fs.writeFile(path.join(engine.directory, name), 'raise RuntimeError("shadowed")\n')
      }
      await fs.writeFile(path.join(engine.directory, "helper.py"), "VALUE = 42\n")
      // A script imports from the session's folder, as Python lets code it is given; what it defines can be pickled.
      const script =
        "import pickle\nfrom helper import VALUE\nclass Area:\n    pass\nprint(VALUE, type(pickle.loads(pickle.dumps(Area()))).__name__)"
      const done = result(await engine.response(engine.send({ script, cwd: engine.directory })))
      assert.equal(done.outcome, "finished", done.output)
      assert.equal(done.output, "42 Area\n")
    } finally {
      await engine.stop()
    }
  },
)

test(
  "a request waiting for Earth Engine is reported, without breaking a line the script left open",
  { skip: !python3 },
  async () => {
    const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
    try {
      assert.equal((await engine.settled()).status, "ready")
      // Guards against a line left open on stdout, as a progress message is, silencing the reports: the run would be
      // stopped as idle while Earth Engine computes.
      const seconds = Python.BEAT_SECONDS * 2 + 1
      const script = `print("computing...", end="", flush=True)\nee.wait(${seconds})\nprint(" done")`
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id, (seconds + 15) * 1000))
      assert.equal(done.outcome, "finished")
      assert.equal(done.output, "computing... done\n")
      const waits = engine.progress(id).filter((data) => typeof data === "object" && data !== null && "waiting" in data)
      assert.ok(waits.length >= 1, JSON.stringify(engine.progress(id)))
    } finally {
      await engine.stop()
    }
  },
)

test("an initialization Earth Engine refuses fails the run with its error", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    await fs.writeFile(path.join(engine.directory, "refuse"), "")
    const response = await engine.response(engine.send({ script: "print(1)", cwd: engine.directory }))
    assert.equal(!response.ok && response.error.code, "initialize-failed")
    assert.match(!response.ok ? response.error.message : "", /required permission to use project majestic/)
  } finally {
    await engine.stop()
  }
})

test("a cancelled run answers at once and ends its process", { skip: !python3 }, async () => {
  const engine = await start(async (directory) => ({ python: await stubbedPython(directory), project: "majestic" }))
  try {
    assert.equal((await engine.settled()).status, "ready")
    const marker = path.join(engine.directory, "pid")
    const id = engine.send({
      script: `import os\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\nee.wait(60)`,
      cwd: engine.directory,
    })
    await until(
      () =>
        fs.stat(marker).then(
          () => true,
          () => false,
        ),
      10000,
      "the script to start",
    )
    const pid = Number(await fs.readFile(marker, "utf-8"))
    engine.deliver({ type: "cancel", id })
    const response = await engine.response(id, 10000)
    assert.equal(!response.ok && response.error.code, "cancelled")
    assert.equal(response.cancelled, true)
    await until(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      10000,
      "the process to end",
    )
  } finally {
    await engine.stop()
  }
})
