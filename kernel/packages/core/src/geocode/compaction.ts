export * as GeoCompaction from "./compaction.js"

import RULES from "./compaction-rules.txt"
import TEMPLATE from "./compaction-template.txt"

/**
 * The summary's template and rules, in place of OpenCode's in session/compaction.ts: the same, with the data a
 * geographic task works on kept too, and the wording that only fits code made to fit data as well.
 */
export const template = TEMPLATE.trimEnd()
export const rules = RULES.trimEnd()
