import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/* The gate has to actually run the tripwires (docs/CONVENTIONS.md).
 *
 * `scripts/test-gate.sh` names its files explicitly — it must, because the
 * vendored suite around them fails by design and cannot be run wholesale. The
 * cost of that choice is a silent one: a new tripwire file sits in the tree,
 * passes when run by hand, and is never run again. It reads as coverage and is
 * not, which is worse than having no test at all.
 *
 * Everything under test/geo/ is picked up by directory, so this only guards
 * the ones named one by one.
 */

/** test/, whose `geocode-*.test.ts` files the gate has to name one by one. */
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

    // A sanity floor: if the glob ever matches nothing, the loop below would
    // pass by doing nothing at all.
    expect(own.length).toBeGreaterThan(4)
    for (const file of own) expect(script).toContain(`test/${file}`)
  })

  test("it runs the geo kernel directory, which is how test/geo/ is covered", () => {
    expect(fs.readFileSync(GATE, "utf8")).toContain("test/geo/")
  })
})
