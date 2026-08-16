export * as NetRedact from "./redact"

/* --- GeoCode: credential stripping for the Net module (docs/GEOKERNEL.md §3.3).
 *
 * A proxy URL can carry `user:password@`. Anything leaving the module strips it
 * and keeps host and port, so a proxy failure stays diagnosable — which is the
 * whole reason the feature exists for users who need one.
 *
 * Three outward exits are planned — status events, diagnostics, logs — and
 * MISSING ANY ONE OF THEM IS THE SAME AS NOT DOING IT AT ALL. That is why this
 * lives in its own module rather than as a helper beside the first caller that
 * needed it: it has to be the obvious thing to reach for at every exit.
 *
 * ⚠️ **None of the three is built, so this has no callers today** (§3.3, and
 * GEOKERNEL §11 records the same). Kept deliberately, not left behind. What
 * that costs is the thing this note exists to name: nothing here is exercised
 * by the code that ships, so its tests are the only thing holding it up — and
 * a filter that has quietly stopped filtering looks exactly like one that
 * works. Its behaviour on the shapes it used to fail open on is pinned in
 * `net-resolve.test.ts` for that reason. --- */

/**
 * The schemes a proxy declaration is written with.
 *
 * A list rather than a pattern, because `scheme:` and `username:` are the same
 * shape and there is no syntax that separates them. `alice:hunter2@host:1080`
 * offers `alice` as a perfectly well-formed scheme, and keeping it would
 * publish the username as the protocol — which is what the first version of
 * this function did, caught by the samples below before it was committed.
 *
 * Anything not on the list and not followed by `//` is removed along with the
 * rest. That loses the protocol on a declaration written in some form nobody
 * here has seen; host and port, which are what identify the proxy to its owner,
 * survive either way.
 */
const PROXY_SCHEMES = new Set(["http", "https", "socks", "socks4", "socks4a", "socks5", "socks5h"])

/**
 * Everything from the scheme separator to the LAST `@`, removed.
 *
 * No attempt is made to decide whether what is being removed looks like
 * userinfo. Deciding that is the judgement `new URL` already makes, and the
 * cases this is reached for are precisely the ones where it decides wrong.
 */
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
 * Strip credentials from a proxy URL.
 *
 * Two passes, and the second one is the point. `new URL` handles the ordinary
 * shape — `scheme://user:pass@host:port` — and handles it exactly. What it does
 * not do is fail LOUDLY on the shapes that matter most, and each of these was
 * measured coming back with the password still in it:
 *
 * ```
 * socks5://alice:pa/ss@10.0.0.9:1080     parses; the `/` puts the password
 *                                        outside userinfo, so there is nothing
 *                                        for the parser to clear
 * socks5://al/ice:secret@10.0.0.9:1080   the same, through the username
 * socks5:alice:hunter2@10.0.0.9:1080     no `//`, and the textual fallback that
 *                                        was here required one
 * alice:hunter2@10.0.0.9:1080            no scheme either
 * ```
 *
 * A credential filter that returns its input unchanged on the inputs it cannot
 * read is not a filter. So the rule is now the other way round: the parser's
 * answer is accepted only when it comes back with NO `@` left in it, and
 * anything else goes through `withoutUserinfo`.
 *
 * That removes more than it has to when the value is not a proxy URL —
 * `http://host/path@v2` comes back as `http://v2`. Deliberate, and the two
 * errors are not comparable: a mangled string in a diagnostic bundle costs a
 * confused reader, and the other one costs a password in a screenshot.
 *
 * ★ Where there is a choice, the stronger answer is not to take the credential
 * at all — `NetDiscovery.skipped` builds its identifier out of parsed fields,
 * so there is nothing to clean and no filter anyone can forget to call. This is
 * for the exits that have no such choice, because what they carry is the user's
 * own raw value.
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
    // Falls through on purpose: a value the parser cannot read is the case a
    // credential is most likely to be hiding in.
  }
  return withoutUserinfo(value)
}

/** Environment variables destined for a log or a diagnostic bundle. */
export function env(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars)) out[key] = url(value)
  return out
}
