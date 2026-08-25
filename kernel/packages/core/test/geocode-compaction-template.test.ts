import { expect, test } from "bun:test"
import { SessionCompaction } from "../src/session/compaction"

/* GeoCode's `Plan and Rules` section, in a template that reaches the model verbatim and so carries no `GeoCode:`
 * marker of its own (GEOKERNEL.md §10.1 #11, KERNEL.md §5.3). Both branches of `buildPrompt` are exercised: the
 * one with a prior summary is the path every compaction after the first takes. */

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
    // The instructions wrapped around the template must not frame the summary as a handover to a coding agent
    // either — the same consequence opencode/test/geocode-compaction-prompt.test.ts guards for the system prompt.
    expect(text.toLowerCase()).not.toContain("coding")
  })
}
