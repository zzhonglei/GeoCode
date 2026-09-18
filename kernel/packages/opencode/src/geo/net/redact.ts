export * as NetRedact from "./redact"

/* --- GeoCode: strips `user:password@` from proxy addresses but keeps host and port, so a proxy failure stays
 * diagnosable (docs/GEOKERNEL.md §3.3). --- */

/** A list, not a pattern: `scheme:` and `username:` are the same shape, so `alice:hunter2@host` would keep `alice`. */
const PROXY_SCHEMES = new Set(["http", "https", "socks", "socks4", "socks4a", "socks5", "socks5h"])

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
 * `new URL` misreads credentials in malformed values, so its answer is used only when no `@` survives it; the rest go
 * through `withoutUserinfo`, which over-removes rather than under: `http://host/path@v2` becomes `http://v2`.
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
