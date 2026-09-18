import { GeoOsm } from "@/geo"

/* --- GeoCode: the report lines both OSM download tools share, so a sentence corrected once is corrected for both;
 * each tool keeps only its own headline. --- */

export function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

/** The only place a missing piece is mentioned, since the file itself says nothing about what it lacks. */
export function caveats(
  result: GeoOsm.DownloadResult,
  options: {
    readonly lostNoun: string
    /** Omitted for OsmGetObjects, which is itself the fetch by id. */
    readonly lostRemedy?: string
    readonly cancelled?: string
  },
): string[] {
  const lines: string[] = []
  if (!result.exact) {
    const named = result.widened.length > 0 ? ` — ${result.widened.join("; ")}` : ""
    lines.push(
      `NOTE: this result covers more ground than was asked for${named}. A boundary file too detailed or too` +
        " fragmented to filter exactly is queried wider, never narrower. It stayed that way because the call" +
        " mixes boundary files with other extent kinds — a call made only of boundary files comes back exact.",
    )
  }
  for (const note of result.notes) lines.push(`NOTE: ${note}`)
  for (const entry of result.incomplete) {
    // The service's remark verbatim: "timed out" and "this query is too broad" ask for opposite fixes.
    lines.push(`NOTE: ${entry.extent} came back incomplete. The service said: ${entry.remark}`)
  }
  for (const entry of result.failed) lines.push(`NOTE: ${entry.extent} — ${entry.reason}`)
  if (result.unassembled.length > 0) {
    // Capped at what one OsmGetObjects call takes; this cap is what keeps both tools' `truncated: false` true.
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

/** The paths the kernel wrote, never the requested one, which may name no file at all (GEOKERNEL §6.7). */
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
