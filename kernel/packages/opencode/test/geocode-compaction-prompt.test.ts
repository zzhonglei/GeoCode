import { expect, test } from "bun:test"
import PROMPT_COMPACTION from "../src/agent/prompt/compaction.txt"

/* --- GeoCode: the compaction agent's system prompt reaches the model verbatim
 * and therefore carries no `GeoCode:` marker (KERNEL.md §5.3). This file is the
 * marker.
 *
 * What it guards is a CONSEQUENCE rather than a wording (PROMPTS.md): the
 * summary must not be framed as a handover to a coding agent. Upstream's own
 * agent writes code, so that framing is its default and comes back with every
 * rewrite of this file — v1.18.18 rewrote all three sentences at once.
 *
 * It matters because of WHO reads the result. Compaction runs on whatever model
 * the session runs on (`session/prompt.ts` passes `lastUser.model`), so a
 * cheaper model summarising a long geographic session is a real configuration,
 * not a hypothetical — and a smaller model takes framing literally. What has to
 * survive compaction here is coordinate systems, output paths and data caveats.
 *
 * ⚠️ Known limit, stated rather than papered over: this catches the word, not
 * the intent. Upstream switching to "software engineer agent" or similar would
 * pass. That case belongs to the manual pass over marker-less files
 * (KERNEL.md §4.4 step 5), which this test does not replace. --- */

test("GeoCode: the compaction prompt does not frame the handover as coding", () => {
  expect(PROMPT_COMPACTION.toLowerCase()).not.toContain("coding")
  // A "does not contain" assertion alone passes on a file that was emptied or
  // renamed out from under the import, so pin what the prompt is FOR.
  expect(PROMPT_COMPACTION).toContain("structured summary")
})
