import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { SOURCE, python3 } from "../../support/common.ts"
import { start, result } from "../../support/gee.ts"

/** What a script prints run by geocodekit's source alone, as in GeoAgent's shell: no tool has set anything up. */
const outside = (script: string) =>
  execFileSync(python3!, ["-I", "-c", `import sys\nsys.path.insert(0, ${JSON.stringify(SOURCE)})\n${script}`], {
    encoding: "utf-8",
  })

const LOADED = "print(sorted(name for name in sys.modules if name.startswith('geocodekit')))"

test("importing geocodekit loads none of its subpackages", { skip: !python3 }, () => {
  // Guards against every import paying for every subpackage, and against loading Earth Engine where it is not used.
  assert.equal(outside(`import geocodekit\n${LOADED}`).trim(), "['geocodekit']")
})

test("geocodekit.gee refuses to load outside geerun, saying where it runs", { skip: !python3 }, () => {
  const tried = [
    "for attempt in ('import geocodekit.gee', 'import geocodekit; geocodekit.gee'):",
    "    try:",
    "        exec(attempt)",
    "    except ImportError as error:",
    "        print(error)",
    LOADED,
  ].join("\n")
  const lines = outside(tried).trim().split("\n")
  assert.equal(lines.length, 3)
  for (const line of lines.slice(0, 2)) assert.match(line, /only in a script run by GeoCode's geerun tool/)
  // Guards against a half-loaded subpackage left behind, which a later import would take for a loaded one.
  assert.equal(lines[2], "['geocodekit', 'geocodekit._tool']")
})

test("in geerun the script reaches geocodekit.gee either way", { skip: !python3 }, async () => {
  const engine = await start("majestic")
  try {
    assert.equal((await engine.settled()).status, "ready")
    const script = ["import geocodekit", "import geocodekit.gee as gee", "print(geocodekit.gee is gee)"]
    const done = result(await engine.response(engine.send({ script: script.join("\n"), cwd: engine.directory })))
    assert.equal(done.outcome, "finished", done.output)
    assert.equal(done.output, "True\n")
  } finally {
    await engine.stop()
  }
})
