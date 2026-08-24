export * as NetRedact from "./redact"

/* --- GeoCode: credential stripping for the Net module (docs/GEOKERNEL.md §3.3).
 *
 * Strips `user:password@` and keeps host and port, so a proxy failure stays diagnosable. Its own module because
 * all three planned exits — status events, diagnostics, logs — have to reach for it, and missing one is the same
 * as not doing it at all (§3.3, §11). --- */

/** A list, not a pattern: `scheme:` and `username:` are the same shape, so `alice:hunter2@host` would keep `alice`. */
const PROXY_SCHEMES = new Set(["http", "https", "socks", "socks4", "socks4a", "socks5", "socks5h"])

/** Cuts from the scheme prefix to the last `@`, or from the start of the value when the prefix is not a proxy scheme. */
function withoutUserinfo(value: string): string {
  // A query or fragment can hold an `@` of its own and is not authority.
  const boundary = value.search(/[?#]/)
  const head = boundary === -1 ? value : value.slice(0, boundary)
  const at = head.lastIndexOf("@")
  if (at === -1) return value
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(value)
  const keep = scheme && (scheme[2] || PROXY_SCHEMES.has(scheme[1]!.toLowerCase()))
  const start = keep ? scheme[0].length : 0
  if (at < start) return value
  return value.slice(0, start) + value.slice(at + 1)
}

/**
 * `new URL` clears userinfo only on a well-formed `scheme://user:pass@host:port`: a `/` in the password throws, one
 * in the username parses the wrong host, and a missing `//` leaves the credential in place. So its answer is used
 * only when no `@` survives it, and everything else goes through `withoutUserinfo`, which over-removes rather than
 * under — `http://host/path@v2` becomes `http://v2`, preferred to a password in a screenshot.
 */
export function url(value: string): string
export function url(value: undefined): undefined
export function url(value: string | undefined): string | undefined
export function url(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) {
      parsed.username = ""
      parsed.password = ""
      const cleaned = parsed.toString()
      if (!cleaned.includes("@")) return cleaned
    } else if (!value.includes("@")) {
      return value
    }
  } catch {
    // A value the parser cannot read is the case a credential is most likely to be hiding in.
  }
  return withoutUserinfo(value)
}

export function env(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) out[key] = url(value)
  return out
}
