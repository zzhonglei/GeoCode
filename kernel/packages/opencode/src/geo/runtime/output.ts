export * as GeoOutput from "./output"

/* --- GeoCode: output utilities shared across GeoKernel (docs/GEOKERNEL.md §3.2,
 * "输出通用件"). Three things every capability module would otherwise write its
 * own slightly different version of. --- */

export interface Truncated {
  readonly text: string
  /** True when the text was cut. Callers surface this rather than pretending completeness. */
  readonly truncated: boolean
}

/**
 * Cap a body of text, keeping the TAIL.
 *
 * The tail is what matters for subprocess output: errors, stack traces and the
 * result marker all arrive at the end. Keeping the head would reliably discard
 * the only part worth reading.
 */
export function truncate(text: string, limit: number): Truncated {
  if (text.length <= limit) return { text, truncated: false }
  const kept = text.slice(text.length - limit)
  return { text: kept, truncated: true }
}

/** Human-readable elapsed time, in one form across every module. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${(minutes - hours * 60).toString().padStart(2, "0")}m`
}

export type Extracted =
  | { readonly ok: true; readonly value: unknown }
  /**
   * The marker never appeared. The script did not reach its output point, which
   * usually means it died during startup — so the raw output IS the diagnosis
   * and must reach the user intact (§4.6 失败分级).
   */
  | { readonly ok: false; readonly kind: "missing"; readonly raw: string }
  /** The marker appeared but its payload would not parse. */
  | { readonly ok: false; readonly kind: "invalid"; readonly raw: string; readonly error: string }

/**
 * Pull a marker-tagged JSON payload out of mixed subprocess output.
 *
 * Subprocess stdout is a noisy shared channel — QGIS and its dependencies write
 * to it during import, initialization and teardown — so parsing the output as a
 * whole is not reliable. Scripts emit their result on a single marked line
 * instead (§4.3 principle 7).
 *
 * Reads the LAST occurrence: a marker string can legitimately appear earlier in
 * echoed arguments or a dependency's own logging, and the real result is always
 * the final one written.
 *
 * "Missing" and "invalid" are kept apart because they mean different things and
 * lead to different fixes.
 */
export function extractMarked(output: string, marker: string): Extracted {
  const index = output.lastIndexOf(marker)
  if (index < 0) return { ok: false, kind: "missing", raw: output }
  const after = output.slice(index + marker.length)
  const end = after.indexOf("\n")
  const payload = (end < 0 ? after : after.slice(0, end)).trim()
  try {
    return { ok: true, value: JSON.parse(payload) }
  } catch (err) {
    return { ok: false, kind: "invalid", raw: output, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface BoundedBuffer {
  readonly push: (chunk: string) => void
  readonly text: () => string
  /** True once anything has been discarded to stay within the bound. */
  readonly dropped: () => boolean
}

/**
 * A text buffer that keeps its tail and stays under a size bound.
 *
 * Bounded as it fills rather than only when read. Runtime accumulates stderr
 * for the whole of an execution even when stdout is being streamed away, so a
 * process that chatters on stderr indefinitely would otherwise grow this
 * without limit — the precise thing §3.2 rules out. The tail is what survives,
 * for the same reason `truncate` keeps it.
 *
 * A single chunk larger than the bound is kept whole rather than sliced here;
 * `truncate` trims that remaining case when the text is read out.
 */
export function boundedBuffer(cap: number): BoundedBuffer {
  const parts: string[] = []
  let size = 0
  let discarded = false
  return {
    push(chunk: string) {
      parts.push(chunk)
      size += chunk.length
      while (size > cap && parts.length > 1) {
        size -= parts.shift()!.length
        discarded = true
      }
    },
    text: () => parts.join(""),
    dropped: () => discarded,
  }
}
