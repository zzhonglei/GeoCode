export * as GeoOutput from "./output"

/* --- GeoCode: output utilities shared across GeoKernel (docs/GEOKERNEL.md §3.2). --- */

export interface Truncated {
  readonly text: string
  readonly truncated: boolean
}

/** Keeps the TAIL: in subprocess output the errors, the traceback and the result marker all arrive at the end. */
export function truncate(text: string, limit: number): Truncated {
  if (text.length <= limit) return { text, truncated: false }
  const kept = text.slice(text.length - limit)
  return { text: kept, truncated: true }
}

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
  /** The script never reached its output point, so the raw output is itself the diagnosis. */
  | { readonly ok: false; readonly kind: "missing"; readonly raw: string }
  | { readonly ok: false; readonly kind: "invalid"; readonly raw: string; readonly error: string }

/** Reads the LAST occurrence: the marker can appear earlier in echoed arguments or a dependency's own logging. */
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
  readonly dropped: () => boolean
}

/** Bounded as it fills, since stderr is kept for a whole execution; a single chunk larger than `cap` is kept whole. */
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

/** The `error` field of a JSON object in stderr, shown instead of the traceback around it; undefined if none. */
export function structuredError(stderr: string): string | undefined {
  const match = /\{.*"error"\s*:.*\}/s.exec(stderr)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[0]) as { error?: unknown }
    return typeof parsed.error === "string" ? parsed.error : undefined
  } catch {
    return undefined
  }
}
