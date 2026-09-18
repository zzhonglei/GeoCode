export * as NetDiscovery from "./discovery"

import { NetProbe } from "./probe"
import { NetTunnel } from "./tunnel"
import type { Target } from "./types"

/* --- GeoCode: proxy candidates from the environment and known loopback ports, never from the operating system's
 * proxy settings (docs/GEOKERNEL.md §3.3). --- */

/** Order is the precedence: `declared` takes the first value that survives `normalize`. */
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const

/** 8080 last: it is as likely to be somebody's development server as a proxy, and the conventions go first. */
const KNOWN_PORTS = [7890, 7897, 10809, 8118, 8080] as const

const LOOPBACK = "127.0.0.1"

export function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  // SOCKS is skipped rather than adopted: consuming runtimes raise without an extra optional dependency.
  if (/^socks/i.test(trimmed)) return undefined
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`
}

/** Built from scheme, host and port alone rather than a redacted raw string, so no cleaning step can fail open. */
function identify(value: string): string {
  // Off the front of the string, so it survives the values `new URL` rejects. The `//` is required: without it the
  // text before the first colon can be a username, and `socksalice:pw@host` would publish it as the scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase() ?? "socks"
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
  // An `@` with no parsed user is a misreading: `socks5://al/ice:secret@host:1080` parses to the host `al`.
  if (value.includes("@") && !user) return `${scheme}:unparseable`
  if (!host) return `${scheme}:unparseable`
  return port ? `${scheme}:${host}:${port}` : `${scheme}:${host}`
}

/** SOCKS declarations that were refused, reported so a user whose network needs that proxy can see why. */
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

/** A declaration goes first but is verified like any other candidate: the variable can name a proxy long stopped. */
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
  // Sequential, or `consider` appends in completion order; a closed loopback port refuses at once.
  for (const port of ports) await consider(`http://${LOOPBACK}:${port}`)

  return found
}

export async function speaksProxy(authority: Target, proxyUrl: string, options: Options = {}): Promise<boolean> {
  // Stops at stage 2: the resolver runs stage 3 on the survivors, and repeating it here doubles the target handshake.
  const result = await NetTunnel.open(
    proxyUrl,
    `${authority.host}:${authority.port}`,
    options.probeTimeoutMs ?? NetProbe.LOOPBACK_TIMEOUT_MS,
  )
  if (result.ok) result.socket.destroy()
  return result.ok
}
