import { expect, test } from "bun:test"
import { SessionCompaction } from "../src/session/compaction"

// Guards the Plan and Rules section, which sits inside a template string the model reads verbatim, where no marker
// can go (GEOKERNEL.md §10.1 #11).

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
    // Nor may the instructions around the template frame the summary as a handover to a coding agent.
    expect(text.toLowerCase()).not.toContain("coding")
  })
}
