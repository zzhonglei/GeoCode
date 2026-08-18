import { expect, test } from "bun:test"
import { SessionCompaction } from "../src/session/compaction"

/* The template text reaches the model verbatim and so carries no `GeoCode:`
 * marker (KERNEL.md §5.3). This file is the marker: it is what notices if an
 * upstream merge rewrites the template and takes the section with it.
 *
 * BOTH branches are exercised, and that is not symmetry for its own sake.
 * v1.18.18 split `buildPrompt` in two — with and without a prior summary — and
 * only the second of those is a FIRST compaction. Every compaction after the
 * first takes the other branch, which is where a long geographic session spends
 * its time. Testing only the first would have left the common path unguarded,
 * which is exactly what happened between that merge and this test. */

const BRANCHES = [
  ["first compaction", { context: ["[User]: reproject dem.tif to 3826"] }],
  ["later compaction", { previousSummary: "## Objective\n- reproject the DEM", context: ["[User]: continue"] }],
] as const

for (const [name, input] of BRANCHES) {
  test(`the compaction template keeps GeoCode's section, in place (${name})`, () => {
    const text = SessionCompaction.buildPrompt(input)
    expect(text).toContain("## Plan and Rules")
    expect(text).toMatch(/agreed sequence of work.+such as projection.+known to be incomplete/)
    expect(text.indexOf("## Important Details")).toBeLessThan(text.indexOf("## Plan and Rules"))
    expect(text.indexOf("## Plan and Rules")).toBeLessThan(text.indexOf("## Work State"))
    // The instructions wrapped around the template must not frame the summary
    // as a handover to a coding agent either — the same consequence the system
    // prompt's tripwire guards (opencode/test/geocode-compaction-prompt.test.ts),
    // and upstream reintroduces that framing in both places independently.
    expect(text.toLowerCase()).not.toContain("coding")
  })
}
