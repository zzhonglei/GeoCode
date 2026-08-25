import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/* The gate has to actually run the tripwires (docs/CONVENTIONS.md §7).
 *
 * `scripts/test-gate.sh` names its files one by one — it must, because the
 * vendored suite around them fails by design and cannot be run wholesale — so
 * a new tripwire file can sit in the tree, pass when run by hand, and never be
 * run again.
 */

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
    // The check above sees only test/'s own naming convention, so a tripwire written as a
    // `GeoCode: …` case inside an upstream file — the only place some of them can live — would
    // otherwise sit unrun while the gate reported green.
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
