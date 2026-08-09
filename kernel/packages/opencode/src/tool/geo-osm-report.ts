import type { GeoOsm } from "@/geo"

/* --- GeoCode: the report both download tools write (docs/TOOLS.md §6).
 *
 * `OsmGetObjects` and `OsmGetFeatures` hand back the same structure and answer
 * the same question about it: what is in the file, what is not, and what the
 * caller has to do about the difference. Only the headline differs — one
 * counts objects it was given by id, the other counts features it found by
 * tag — so that stays with each tool and everything below it lives here.
 *
 * Shared for the reason TOOLS.md §7 gives for the file-extension list: not to
 * write less code, but so the two cannot drift. A sentence corrected in one
 * copy and not the other is worse than either version, because the two tools
 * then describe the same situation differently and the reader has to work out
 * which one is current. --- */

export function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Everything that qualifies the numbers, before the numbers.
 *
 * A reader who meets a caveat afterwards has already read the figures as
 * complete — the rule OsmProbe established, and it matters more here: this is
 * the only place the absence of something is ever mentioned. The file itself
 * will not say a word about what is not in it.
 *
 * Ordered by how far each one reaches: the whole-run notes first, then the
 * ones about a single extent or a single element.
 */
export function caveats(
  result: GeoOsm.DownloadResult,
  options: {
    /** What one lost element is called here: an object asked for, or a feature found. */
    readonly lostNoun: string
    /** The sentence for a cancelled run, or undefined when it ran to the end. */
    readonly cancelled?: string
  },
): string[] {
  const lines: string[] = []
  // The kernel's own prose: the route it had to fall back to, and the fact
  // that an empty run created no file at all.
  for (const note of result.notes) lines.push(`NOTE: ${note}`)
  for (const entry of result.incomplete) {
    // The service's own words, carried through rather than summarized:
    // "timed out" and "this query is too broad" ask for opposite things, and
    // only the service knows which happened (§6.3 第四种失败).
    lines.push(`NOTE: ${entry.extent} came back incomplete. The service said: ${entry.remark}`)
  }
  for (const entry of result.failed) lines.push(`NOTE: ${entry.extent} — ${entry.reason}`)
  if (result.unassembled.length > 0) {
    // By identity, never a count: the fix for a dropped element is to fetch it
    // on its own, which needs to know which one it was.
    lines.push(
      `NOTE: ${result.unassembled.length} ${options.lostNoun}(s) matched but produced no geometry —` +
        ` ${result.unassembled.join(", ")}`,
    )
  }
  if (options.cancelled) lines.push(`NOTE: ${options.cancelled}`)
  return lines
}

/**
 * Where the data actually landed.
 *
 * Always the paths the kernel wrote, never the one that was asked for: a name
 * already taken gets numbered, a base without an extension gets one, and a run
 * spanning several geometry families is split into siblings — so the requested
 * path can name a file that does not exist (§6.7).
 */
export function files(result: GeoOsm.DownloadResult, scope: string): string[] {
  if (result.outputs.length === 1) {
    return [`Wrote ${scope} to ${result.outputs[0]!.path} (${size(result.bytes)}).`]
  }
  const width = Math.max(...result.outputs.map((entry) => entry.path.length))
  // Why it splits is a design decision and lives in the kernel's comment. What
  // the caller needs is the list.
  return [
    `Mixed geometry families, so the result was split into ${result.outputs.length} files` +
      ` — ${scope}, ${size(result.bytes)}:`,
    "",
    ...result.outputs.map((entry) => `  ${entry.path.padEnd(width)}  ${entry.family}: ${entry.count}`),
    "",
  ]
}

/**
 * What the file contains, column-wise.
 *
 * Both halves of the field contract (§6.6): the columns that are there, and
 * the keys that were dropped with a count each — enough to decide whether a
 * second call is worth making, and the route to make one.
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
