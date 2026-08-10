import { expect, test } from "bun:test"
import { SessionCompaction } from "../src/session/compaction"

/* The template text reaches the model verbatim and so carries no `GeoCode:`
 * marker (KERNEL.md §5.3). This file is the marker: it is what notices if an
 * upstream merge rewrites the template and takes the section with it. */

test("the compaction template keeps GeoCode's section, in place", () => {
  const text = SessionCompaction.buildPrompt({ context: [] })
  expect(text).toContain("## Plan and Rules")
  expect(text).toMatch(/agreed sequence of work.+such as projection.+known to be incomplete/)
  expect(text.indexOf("## Important Details")).toBeLessThan(text.indexOf("## Plan and Rules"))
  expect(text.indexOf("## Plan and Rules")).toBeLessThan(text.indexOf("## Work State"))
})
