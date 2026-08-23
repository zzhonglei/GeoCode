export * as NetDiscovery from "./discovery"

import { NetProbe } from "./probe"
import { NetTunnel } from "./tunnel"
import type { Target } from "./types"

/* --- GeoCode: finding proxy candidates, reached only after a direct connection has failed (docs/GEOKERNEL.md §3.3).
 *
 * Two sources, and no third: the operating system's own proxy settings are deliberately not read (§12). --- */

/** Order is the precedence — `declared` takes the first value that survives `normalize`, so a SOCKS one is passed over. */
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const

/** 8080 last: it is as likely to be somebody's development server as a proxy, and the conventions go first. */
const KNOWN_PORTS = [7890, 7897, 10809, 8118, 8080] as const

const LOOPBACK = "127.0.0.1"

export function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  // SOCKS is skipped rather than adopted: consuming runtimes raise without an extra optional dependency (§12).
  if (/^socks/i.test(trimmed)) return undefined
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`
}

/**
 * A declaration named the way `routeId` names a route: scheme, host, port.
 *
 * Assembled from parsed fields, never from the raw string with the credentials wiped — a hostname and a port cannot
 * carry a `user:password@` even in principle, so there is no cleaning step to fail open.
 */
function identify(value: string): string {
  // Off the front of the string, so it survives the values `new URL` rejects; it stops at the first colon.
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
  // An `@` the parser saw no user for means it read the string as something else: `socks5://al/ice:secret@host:1080`
  // parses to the host `al`, half a username, so neither the catch nor the empty-host check below sees it.
  if (value.includes("@") && !user) return `${scheme}:unparseable`
  if (!host) return `${scheme}:unparseable`
  return port ? `${scheme}:${host}:${port}` : `${scheme}:${host}`
}

/**
 * Proxy declarations that were found and refused, reported rather than acted on: a user whose network only works
 * through that proxy otherwise sees "cannot be reached" forever with nothing to go on (§12).
 */
export function skipped(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = []
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim()
    // The same test `normalize` refuses on, so the two cannot disagree about what was skipped.
    if (!value || !/^socks/i.test(value)) continue
    const id = identify(value)
    if (!found.includes(id)) found.push(id)
  }
  return found
}

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
 * Proxy addresses worth trying, in the order to try them. A declaration goes first but is verified like any other
 * candidate — an environment variable can name a proxy that stopped running months ago (§3.3).
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
  // Sequential, or the order above means nothing; a closed loopback port refuses in about a millisecond.
  for (const port of ports) await consider(`http://${LOOPBACK}:${port}`)

  return found
}

/** Whether an address speaks proxy does not depend on the target; the decision that uses the answer does (§3.3). */
export async function speaksProxy(authority: Target, proxyUrl: string, options: Options = {}): Promise<boolean> {
  // Stops at the end of stage 2: the resolver runs stage 3 on the survivors, so probing it here too would cost every
  // working proxy a second handshake with the target.
  const result = await NetTunnel.open(
    proxyUrl,
    `${authority.host}:${authority.port}`,
    options.probeTimeoutMs ?? NetProbe.LOOPBACK_TIMEOUT_MS,
  )
  if (result.ok) result.socket.destroy()
  return result.ok
}
