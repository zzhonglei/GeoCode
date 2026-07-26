export * as NetRedact from "./redact"

/* --- GeoCode: credential stripping for the Net module (docs/GEOKERNEL.md §3.3).
 *
 * A proxy URL can carry `user:password@`. Anything leaving the module strips it
 * and keeps host and port, so a proxy failure stays diagnosable — which is the
 * whole reason the feature exists for users who need one.
 *
 * There are exactly three outward exits — status events, diagnostics, logs —
 * and MISSING ANY ONE OF THEM IS THE SAME AS NOT DOING IT AT ALL. That is why
 * this lives in its own module rather than as a helper beside the first caller
 * that needed it: it has to be the obvious thing to reach for at every exit. --- */

/**
 * Strip credentials from a proxy URL.
 *
 * Falls back to a textual strip when the value will not parse: an unparseable
 * URL is exactly the case where credentials would otherwise slip through, so
 * failing open is not an option.
 */
export function url(value: string): string
export function url(value: undefined): undefined
export function url(value: string | undefined): string | undefined
export function url(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const parsed = new URL(value)
    if (!parsed.username && !parsed.password) return value
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return value.replace(/\/\/[^/@]*@/, "//")
  }
}

/** Environment variables destined for a log or a diagnostic bundle. */
export function env(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) out[key] = url(value)
  return out
}
