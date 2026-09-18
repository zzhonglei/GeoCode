import { expect, test } from "bun:test"
import PROMPT_COMPACTION from "../src/agent/prompt/compaction.txt"

/* --- GeoCode: compaction.txt reaches the model verbatim and carries no marker, so only this catches a merge that
 * frames the summary as a handover to a coding agent again (KERNEL.md §5.3). --- */

test("GeoCode: the compaction prompt does not frame the handover as coding", () => {
  expect(PROMPT_COMPACTION.toLowerCase()).not.toContain("coding")
  // A "does not contain" assertion alone passes on a file emptied or renamed out from under the import.
  expect(PROMPT_COMPACTION).toContain("structured summary")
})
