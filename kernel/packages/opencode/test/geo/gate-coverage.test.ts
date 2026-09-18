import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/* Guards against a tripwire file that passes by hand but is never run, since the gate names its files one by one
 * (docs/CONVENTIONS.md §7). */

/** The parent test/ directory, not this one: its `geocode-*.test.ts` files are the ones named. */
const HERE = path.dirname(import.meta.dirname)
/** test → opencode → packages → kernel → the repository root. */
const GATE = path.resolve(HERE, "..", "..", "..", "..", "scripts", "test-gate.sh")

describe("the test gate", () => {
  test("every named tripwire file in test/ is in it", () => {
    const script = fs.readFileSync(GATE, "utf8")
    const own = fs
      .readdirSync(HERE)
      .filter((entry) => entry.startsWith("geocode-") && entry.endsWith(".test.ts"))
      .sort()

    // A floor: if the filter ever matched nothing, the loop below would pass by doing nothing.
    expect(own.length).toBeGreaterThan(4)
    for (const file of own) expect(script).toContain(`test/${file}`)
  })

  test("it runs the geo kernel directory, which is how test/geo/ is covered", () => {
    expect(fs.readFileSync(GATE, "utf8")).toContain("test/geo/")
  })

  test("and every upstream test file holding a GeoCode-named case is in it too", () => {
    // The name filter above cannot see a `GeoCode: …` case written inside an upstream test file.
    const script = fs.readFileSync(GATE, "utf8")
    const holders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        // test/geo/ is covered by directory, so its files are never named.
        if (entry.isDirectory()) {
          if (full !== import.meta.dirname) walk(full)
          continue
        }
        if (!entry.name.endsWith(".test.ts")) continue
        if (/\b(?:test|it)(?:\.\w+)*\(\s*"GeoCode:/.test(fs.readFileSync(full, "utf8"))) {
          holders.push(path.relative(path.dirname(HERE), full).split(path.sep).join("/"))
        }
      }
    }
    walk(HERE)

    expect(holders.length).toBeGreaterThan(0)
    for (const file of holders) expect(script).toContain(file)
  })
})
