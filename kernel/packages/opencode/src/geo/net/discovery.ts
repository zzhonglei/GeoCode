export * as NetDiscovery from "./discovery"

import { NetProbe } from "./probe"
import { NetTunnel } from "./tunnel"
import type { Target } from "./types"

/* --- GeoCode: finding proxy candidates (docs/GEOKERNEL.md §3.3).
 *
 * Only reached when a direct connection has already failed, so on a machine
 * with working direct access none of this ever runs.
 *
 * Two sources, and no third. In particular the operating system's own proxy
 * settings are NOT read — see the tradeoff record in §12. The short version:
 * proxy software opens a local port whether or not the user turns on "system
 * proxy" mode, so the port list already covers the same people, and reading the
 * OS setting would buy a narrow extra slice at the price of platform-specific
 * reading, cache invalidation and dead-port handling. --- */

/**
 * Proxy variables in the process environment, most specific first.
 *
 * This layer is thin in practice: an application launched from a desktop does
 * not inherit a shell's environment, so it is usually empty and only has a
 * value when the sidecar was started from a terminal. It stays because it is
 * the one way to declare a proxy the port list cannot know about — a corporate
 * proxy, or an unusual port — and because an explicit statement of intent
 * deserves to be honoured.
 */
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const

/**
 * Ports the mainstream proxy tools listen on.
 *
 * This layer carries the real load. 8080 comes last on purpose: it is at least
 * as likely to be somebody's local development server as a proxy, and while
 * asking is harmless — stage 2 exposes a non-proxy in milliseconds — there is
 * no reason to ask it before the ports that are actually conventions.
 */
const KNOWN_PORTS = [7890, 7897, 10809, 8118, 8080] as const

const LOOPBACK = "127.0.0.1"

/** Everything the module treats as a proxy address it can use. */
export function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  // A SOCKS-only declaration is skipped rather than adopted: consuming runtimes
  // need an extra optional dependency to speak it and raise without one, which
  // would break users whose direct connection works fine today (§12).
  if (/^socks/i.test(trimmed)) return undefined
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`
}

/**
 * A declaration named the way `routeId` names a route: scheme, host, port.
 *
 * **The password is never taken, rather than taken and wiped.** Redaction is a
 * safety net and this is a credential path, so the value that leaves is built
 * from parsed fields — a hostname and a port cannot carry a `user:password@`
 * even in principle. The raw declaration does not go anywhere.
 *
 * THREE ways a value fails to yield a host, and all of them end the same. The
 * first is obvious and the other two are not:
 *   - it does not parse at all (`socks5://user:pa/ss@host` — a `/` in the
 *     PASSWORD is enough for the URL parser to give up)
 *   - it parses and the host comes back EMPTY (`socks5:host:1080`, with no
 *     `//`) — nothing is thrown for that one, so a bare try/catch would let a
 *     useless `scheme::` through
 *   - it parses and the host comes back WRONG. A `/` in the USERNAME ends the
 *     authority early, so `socks5://al/ice:secret@10.0.0.9:1080` yields the
 *     host `al` — half a username, published as if it were a machine. Nothing
 *     is thrown and the host is not empty; the only tell is that the value
 *     plainly has an `@` while the parse found no user at all.
 * All three answer `scheme:unparseable`, the direction `routeId` fails in too.
 */
function identify(value: string): string {
  // Read off the front of the string, so it survives the cases the parser
  // rejects. It stops at the first colon and can never reach the userinfo.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? "socks"
  let host = ""
  let port = ""
  let user = ""
  try {
    const parsed = new URL(value)
    host = parsed.hostname
    port = parsed.port
    user = parsed.username
  } catch {
    // Handled below: an unusable host is the single condition, however it arose.
  }
  // Credentials the parser did not see mean it read the string as something
  // other than what was written, and whatever it calls the host then comes from
  // the wrong side of the `@`. Conservative on purpose: a proxy URL carrying an
  // `@` anywhere else is odd, and refusing to name it costs a reader nothing
  // they cannot get from their own configuration.
  if (value.includes("@") && !user) return `${scheme}:unparseable`
  if (!host) return `${scheme}:unparseable`
  // A port the user did not write is not invented. Saying which port is the
  // whole value of this to a reader recognising their own configuration, and a
  // guessed 1080 would be a fact we made up.
  return port ? `${scheme}:${host}:${port}` : `${scheme}:${host}`
}

/**
 * Proxy declarations that were found and could not be used.
 *
 * Skipping a SOCKS proxy is the right call — the runtimes underneath need an
 * extra dependency to speak it and raise without one, which would break users
 * whose direct connection works today (§12). What was wrong was doing it
 * SILENTLY. A user whose network only works through that proxy sees "cannot be
 * reached" forever, and neither they nor a support conversation has anything to
 * go on: the one fact that explains it was known here and thrown away.
 *
 * Reported rather than acted on. Nothing here changes what gets tried; it only
 * stops the reason from being invisible, which is the whole of what §12 left
 * open.
 */
export function skipped(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = []
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim()
    // The same test `normalize` refuses on, so the two cannot disagree about
    // what was skipped and why.
    if (!value || !/^socks/i.test(value)) continue
    const id = identify(value)
    // One declaration exported under three names is one thing to report.
    if (!found.includes(id)) found.push(id)
  }
  return found
}

/** The proxy the user declared through the environment, if any. */
export function declared(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ENV_KEYS) {
    const normalized = normalize(env[key])
    if (normalized) return normalized
  }
  return undefined
}

export interface Options {
  readonly env?: NodeJS.ProcessEnv
  readonly ports?: readonly number[]
  readonly probeTimeoutMs?: number
  readonly tls?: NetProbe.Options["tls"]
}

/**
 * Proxy addresses worth trying, in the order to try them.
 *
 * A declaration comes first, but it is NOT trusted on sight: an environment
 * variable can be stale and name a proxy that stopped running months ago. Every
 * candidate here has answered a tunnel request — stages 1 and 2 of §3.3 — and
 * still has to survive stage 3 against the specific target before it is adopted.
 *
 * **This is not a port scan.** Nothing enumerates the machine's ports; a fixed,
 * short list is asked one protocol question each.
 */
export async function candidates(authority: Target, options: Options = {}): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()

  const consider = async (url: string) => {
    if (seen.has(url)) return
    seen.add(url)
    if (await speaksProxy(authority, url, options)) found.push(url)
  }

  const explicit = declared(options.env)
  if (explicit) await consider(explicit)

  const ports = options.ports ?? KNOWN_PORTS
  // Sequential rather than parallel: the list is short, a closed loopback port
  // refuses in about a millisecond, and going in order is what makes the
  // ordering above mean anything.
  for (const port of ports) await consider(`http://${LOOPBACK}:${port}`)

  return found
}

/**
 * Does something at this address answer as a proxy?
 *
 * Stages 1 and 2 only. The answer is a property of the address rather than of
 * any one target, which is why it can be shared across targets while the
 * decision to actually use it stays per-target (§3.3).
 */
export async function speaksProxy(authority: Target, proxyUrl: string, options: Options = {}): Promise<boolean> {
  // Stages 1 and 2 only, and literally so — this opens the tunnel and stops.
  // Running the full three-stage probe here would answer the question, but the
  // resolver then runs it again on the survivors, so every working proxy would
  // pay for two handshakes with the target instead of one.
  const result = await NetTunnel.open(
    proxyUrl,
    `${authority.host}:${authority.port}`,
    options.probeTimeoutMs ?? NetProbe.LOOPBACK_TIMEOUT_MS,
  )
  if (result.ok) result.socket.destroy()
  return result.ok
}
