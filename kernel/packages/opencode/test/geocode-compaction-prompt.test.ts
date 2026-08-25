import { expect, test } from "bun:test"
import PROMPT_COMPACTION from "../src/agent/prompt/compaction.txt"

/* --- GeoCode: the compaction agent's system prompt reaches the model verbatim and so carries no `GeoCode:` marker
 * (KERNEL.md §5.3); this file is the marker. It catches the word, not the intent: what must not come back is the
 * summary framed as a handover to a coding agent, since compaction runs on whatever model the session runs on
 * (`session/prompt.ts` passes `lastUser.model`) and a smaller one takes that framing literally. --- */

test("GeoCode: the compaction prompt does not frame the handover as coding", () => {
  expect(PROMPT_COMPACTION.toLowerCase()).not.toContain("coding")
  // A "does not contain" assertion alone passes on a file emptied or renamed out from under the import.
  expect(PROMPT_COMPACTION).toContain("structured summary")
})
