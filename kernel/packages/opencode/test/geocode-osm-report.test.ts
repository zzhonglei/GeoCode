import { describe, expect, test } from "bun:test"
import { OsmReport } from "../src/tool/geo-osm-report"
import { GeoOsm } from "../src/geo"

// Both download tools declare truncated: false, which bypasses the output cap in tool.ts, so a report line that grows
// with the download reaches the model whole (docs/TOOLS.md §5).

const RESULT = (unassembled: string[]): any => ({
  outputs: [],
  features: 0,
  bytes: 0,
  keptFields: [],
  geometry: {},
  droppedFields: [],
  failed: [],
  incomplete: [],
  extentsDone: 1,
  extentsAsked: 1,
  duplicates: 0,
  centroidConverted: 0,
  exact: true,
  notes: [],
  unassembled,
})

const ids = (count: number) => Array.from({ length: count }, (_, i) => `W${i}`)
const REMEDY = "Fetch the ones that matter with OsmGetObjects."
const lost = (count: number, remedy?: string) =>
  OsmReport.caveats(RESULT(ids(count)), { lostNoun: "element", lostRemedy: remedy }).join("\n")

describe("the elements that produced no geometry", () => {
  test("all of them are named while they fit in one follow-up", () => {
    const line = lost(3, REMEDY)
    expect(line).toContain("W0, W1, W2")
    expect(line).not.toContain("more")
  })

  test("naming stops at what OsmGetObjects accepts in one call", () => {
    expect(lost(1000, REMEDY).match(/W\d+/g)).toHaveLength(GeoOsm.MAX_IDS)
    expect(lost(GeoOsm.MAX_IDS, REMEDY).match(/W\d+/g)).toHaveLength(GeoOsm.MAX_IDS)
  })

  test("the ones it did not name are counted, and the total still leads", () => {
    const line = lost(1000, REMEDY)
    expect(line).toContain("1000 element(s)")
    expect(line).toContain(`and ${1000 - GeoOsm.MAX_IDS} more`)
  })

  test("exactly one follow-up's worth is never described as incomplete", () => {
    expect(lost(GeoOsm.MAX_IDS, REMEDY)).not.toContain("more")
  })

  test("★ its length does not follow the size of the download", () => {
    const full = lost(GeoOsm.MAX_IDS, REMEDY)
    const flood = lost(100_000, REMEDY)
    expect(flood.length - full.length).toBeLessThan(40)
  })

  test("a caller that IS the remedy is not sent back to itself", () => {
    const line = OsmReport.caveats(RESULT(ids(3)), { lostNoun: "object" }).join("\n")
    expect(line).toContain("W0, W1, W2")
    expect(line).not.toContain("OsmGetObjects")
  })

  test("nothing is said when nothing was lost", () => {
    expect(OsmReport.caveats(RESULT([]), { lostNoun: "element", lostRemedy: REMEDY })).toEqual([])
  })
})
