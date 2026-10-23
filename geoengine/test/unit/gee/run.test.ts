import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { Python } from "../../../src/gee/python.ts"
import { until } from "../../support/common.ts"
import { python3, start, result } from "../../support/gee.ts"

test(
  "a run hands GeoAgent what the script printed, and nothing printed before it began",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
    try {
      const ready = await engine.settled()
      assert.ok(ready.status === "ready")
      const script = 'import os\nprint("中文", os.getcwd())\nprint(ee.Number(1).getInfo())'
      const id = engine.send({ script, cwd: engine.directory })
      const done = result(await engine.response(id))
      assert.equal(done.outcome, "finished")
      const cwd = await fs.realpath(engine.directory)
      assert.equal(done.output, `中文 ${cwd}\n1\n`)
      assert.doesNotMatch(done.output, /Earth Engine|__GEOCODE_GEE__/)
      // Guards against the tool row's log losing or adding to what the answer has.
      const [begun, ...printed] = engine.progress(id) as [unknown, ...{ output: string }[]]
      assert.deepEqual(begun, { begun: true })
      assert.ok(printed.every((data) => Object.keys(data).join() === "output"))
      assert.equal(printed.map((data) => data.output).join(""), done.output)
    } finally {
      await engine.stop()
    }
  },
)

test("a failing script ends with its traceback, from its own lines", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const done = result(
      await engine.response(engine.send({ script: "divisor = 0\nvalue = 1 / divisor\n", cwd: engine.directory })),
    )
    assert.equal(done.outcome, "failed")
    assert.match(
      done.output,
      /^Traceback \(most recent call last\):\n {2}File "<script>", line 2, in <module>\n {4}value = 1 \/ divisor\n/,
    )
    assert.match(done.output, /ZeroDivisionError/)
    assert.doesNotMatch(done.output, /<stdin>/)
  } finally {
    await engine.stop()
  }
})

test(
  "a file in the session's folder named like a module the run needs does not replace it, and the script runs as __main__",
  { skip: !python3 },
  async () => {
    const engine = await start("majestic")
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
    const engine = await start("majestic")
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

test("a run stopped during a download leaves no unfinished file", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    // Guards against the hidden file of a stopped download staying in the user's folder.
    const unfinished = path.join(engine.directory, ".area.tif.1.part")
    // Guards against removing a file of the user's that a line of output names.
    const kept = path.join(engine.directory, "thesis.tif")
    await fs.writeFile(kept, "mine")
    const script = [
      "import time",
      "from geocode import _run",
      `_run.partial(${JSON.stringify(unfinished)})`,
      `open(${JSON.stringify(unfinished)}, "w").write("half")`,
      `_run.partial(${JSON.stringify(kept)})`,
      'print("downloading", flush=True)',
      "time.sleep(60)",
    ].join("\n")
    const id = engine.send({ script, cwd: engine.directory })
    await until(() => JSON.stringify(engine.progress(id)).includes("downloading"), 20000, "the download to start")
    engine.deliver({ type: "cancel", id })
    const response = await engine.response(id)
    assert.equal(!response.ok && response.error.code, "cancelled")
    await assert.rejects(fs.access(unfinished))
    await fs.access(kept)
  } finally {
    await engine.stop()
  }
})
