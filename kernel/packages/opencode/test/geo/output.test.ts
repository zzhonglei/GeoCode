import { expect, describe, test } from "bun:test"
import { GeoOutput } from "@/geo/runtime/output"

/* The shared output utilities (docs/GEOKERNEL.md §3.2 输出通用件). Small, but
 * each one encodes a decision that is easy to reverse by accident. */

describe("geo output utilities", () => {
  test("truncation keeps the tail", () => {
    const text = "head".padEnd(500, "-") + "TAIL"
    const result = GeoOutput.truncate(text, 20)
    expect(result.truncated).toBe(true)
    // Errors, stack traces and the result marker all arrive last. Keeping the
    // head would reliably throw away the only part worth reading.
    expect(result.text.endsWith("TAIL")).toBe(true)
    expect(result.text.length).toBe(20)
  })

  test("text within the cap is untouched and unmarked", () => {
    const result = GeoOutput.truncate("short", 20)
    expect(result).toEqual({ text: "short", truncated: false })
  })

  test("a marked payload is read from its last occurrence", () => {
    // The marker legitimately appears earlier — echoed in an argument here, but
    // just as easily in a dependency's own logging. The real result is the last.
    const output = [
      "Running with --marker GEO_RESULT: (echoed by the launcher)",
      "some library warning",
      `GEO_RESULT: {"ok":true,"value":42}`,
      "cleanup chatter after the result",
    ].join("\n")

    const extracted = GeoOutput.extractMarked(output, "GEO_RESULT: ")
    expect(extracted.ok).toBe(true)
    if (extracted.ok) expect(extracted.value).toEqual({ ok: true, value: 42 })
  })

  test("a missing marker is reported apart from an unparsable one", () => {
    // Different meanings, different fixes: no marker means the script never
    // reached its output point — it died on startup — so the raw output is the
    // diagnosis and has to survive intact (§4.6).
    const missing = GeoOutput.extractMarked("Traceback ...\nImportError: no module named qgis", "GEO_RESULT: ")
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.kind).toBe("missing")
      expect(missing.raw).toContain("ImportError")
    }

    const invalid = GeoOutput.extractMarked("GEO_RESULT: {not json", "GEO_RESULT: ")
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.kind).toBe("invalid")
  })

  test("durations read the same way everywhere", () => {
    expect(GeoOutput.formatDuration(420)).toBe("420ms")
    expect(GeoOutput.formatDuration(4200)).toBe("4.2s")
    expect(GeoOutput.formatDuration(125_000)).toBe("2m05s")
    expect(GeoOutput.formatDuration(3_780_000)).toBe("1h03m")
  })

  test("a bounded buffer keeps its tail and says when it dropped", () => {
    const buffer = GeoOutput.boundedBuffer(10)
    expect(buffer.dropped()).toBe(false)
    buffer.push("12345")
    buffer.push("67890")
    expect(buffer.text()).toBe("1234567890")
    expect(buffer.dropped()).toBe(false)

    // Over the bound: the oldest goes, the newest stays. Runtime accumulates
    // stderr for a whole execution, so a process that chatters forever must not
    // be able to grow this without limit (§3.2).
    buffer.push("abcde")
    expect(buffer.text()).toBe("67890abcde")
    expect(buffer.dropped()).toBe(true)
  })

  test("a bounded buffer keeps a single oversized chunk for truncate to trim", () => {
    const buffer = GeoOutput.boundedBuffer(4)
    buffer.push("0123456789")
    // Dropping it would leave nothing at all; the caller trims on read instead.
    expect(buffer.text()).toBe("0123456789")
    expect(GeoOutput.truncate(buffer.text(), 4).text).toBe("6789")
  })
})
