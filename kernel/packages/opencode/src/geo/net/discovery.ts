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
  const result = await NetTunnel.open(proxyUrl, `${authority.host}:${authority.port}`, options.probeTimeoutMs ?? 5_000)
  if (result.ok) result.socket.destroy()
  return result.ok
}
