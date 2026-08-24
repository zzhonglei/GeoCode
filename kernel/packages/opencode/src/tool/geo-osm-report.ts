import { GeoOsm } from "@/geo"

/* --- GeoCode: the report both download tools write (docs/TOOLS.md §6). They hand back the same `DownloadResult`
 * and only the headline differs, so that stays with each tool and the rest lives here — shared so that a sentence
 * corrected once cannot leave the two tools describing the same situation differently. --- */

export function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Everything that qualifies the numbers, before the numbers: this is the only place the absence of something is
 * mentioned at all, since the file itself says nothing about what is not in it. Ordered by reach — the whole-run
 * notes first, then the ones about a single extent or element.
 */
export function caveats(
  result: GeoOsm.DownloadResult,
  options: {
    /** What one lost element is called here: an object asked for by id, or an element found by tag. */
    readonly lostNoun: string
    /**
     * Omitted where there is nothing to do: OsmGetObjects IS the fetch-by-id, so a way out leading back to it
     * would cost the caller a round trip to learn what this line could have said.
     */
    readonly lostRemedy?: string
    readonly cancelled?: string
  },
): string[] {
  const lines: string[] = []
  if (!result.exact) {
    // First, because it rescales the whole result; `widened` names the boundary to ask for on its own (§6.4).
    const named = result.widened.length > 0 ? ` — ${result.widened.join("; ")}` : ""
    lines.push(
      `NOTE: this result covers more ground than was asked for${named}. A boundary file too detailed or too` +
        " fragmented to filter exactly is queried wider, never narrower. It stayed that way because the call" +
        " mixes boundary files with other extent kinds — a call made only of boundary files comes back exact.",
    )
  }
  // The kernel's own prose: the route it fell back to, and the fact that an empty run created no file at all.
  for (const note of result.notes) lines.push(`NOTE: ${note}`)
  for (const entry of result.incomplete) {
    // The service's own words rather than a summary: "timed out" and "this query is too broad" ask the caller to
    // do opposite things (§6.3 第四种失败).
    lines.push(`NOTE: ${entry.extent} came back incomplete. The service said: ${entry.remark}`)
  }
  for (const entry of result.failed) lines.push(`NOTE: ${entry.extent} — ${entry.reason}`)
  if (result.unassembled.length > 0) {
    /* By identity, never a count: the fix for a dropped element is to fetch it on its own. Capped at what
     * OsmGetObjects takes in one call, so the list is exactly one follow-up's worth — and it is this cap that keeps
     * both tools' `truncated: false` honest, since nothing else here grows with the size of the download (§5.2). */
    const shown = result.unassembled.slice(0, GeoOsm.MAX_IDS)
    const rest = result.unassembled.length - shown.length
    lines.push(
      `NOTE: ${result.unassembled.length} ${options.lostNoun}(s) matched but produced no geometry — ` +
        shown.join(", ") +
        (rest > 0 ? `, and ${rest} more` : "") +
        "." +
        (options.lostRemedy ? ` ${options.lostRemedy}` : ""),
    )
  }
  if (options.cancelled) lines.push(`NOTE: ${options.cancelled}`)
  return lines
}

/**
 * Always the paths the kernel wrote, never the one asked for: a taken name is numbered, a base without an extension
 * gets one, and several geometry families are split into siblings — so the requested path can name no file (§6.7).
 */
export function files(result: GeoOsm.DownloadResult, scope: string): string[] {
  if (result.outputs.length === 1) {
    return [`Wrote ${scope} to ${result.outputs[0]!.path} (${size(result.bytes)}).`]
  }
  const width = Math.max(...result.outputs.map((entry) => entry.path.length))
  return [
    `Mixed geometry families, so the result was split into ${result.outputs.length} files` +
      ` — ${scope}, ${size(result.bytes)}:`,
    "",
    ...result.outputs.map((entry) => `  ${entry.path.padEnd(width)}  ${entry.family}: ${entry.count}`),
    "",
  ]
}

/**
 * Both halves of the field contract (§6.6): the columns the policy keeps, and the keys it dropped with a count
 * each, which is what a caller needs to decide whether a second call is worth making.
 */
export function fields(result: GeoOsm.DownloadResult): string[] {
  const geometry = Object.entries(result.geometry)
    .map(([type, count]) => `${type}×${count}`)
    .join(", ")
  return [
    `Geometry: ${geometry || "none"}.  CRS: EPSG:4326.`,
    `Fields kept: ${result.keptFields.join(", ")}.`,
    result.droppedFields.length > 0
      ? `Fields dropped: ${result.droppedFields.join(", ")} — ask again with fields:[...] to keep any of them,` +
        ' or fields:["*"] for a lossless osm_tags column.'
      : "Fields dropped: none.",
  ]
}

export * as OsmReport from "./geo-osm-report"
