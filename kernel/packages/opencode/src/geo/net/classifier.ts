export * as NetClassifier from "./classifier"

import os from "node:os"
import type { FailureKind } from "./types"

/* --- GeoCode: telling one kind of failure from another (docs/GEOKERNEL.md §3.3).
 *
 * A two-way split, and ONLY to drive behaviour. It never produces wording: the
 * sentence a user reads about a network problem is the same either way, with
 * the original error travelling alongside as diagnostics. Splitting for the
 * sake of nicer messages is how a "network layer" ends up owning copy. --- */

/**
 * Error codes the operating system raises when the machine itself has no route.
 *
 * These are interface-level and unambiguous — not "this host is being slow" but
 * "there is nowhere to send this". Host-level codes are deliberately absent:
 * an unreachable host can equally mean that one service is having a bad day,
 * which is exactly the ambiguity hysteresis exists to absorb.
 */
const OFFLINE_CODES = ["ENETDOWN", "ENETUNREACH"]

/**
 * Is any address on this interface one that packets can actually be routed to?
 *
 * Link-local addresses are not. A real machine carries several interfaces that
 * only ever hold one — on macOS, `awdl0` and `llw0` exist for AirDrop and are
 * always present, and idle tunnel interfaces keep an `fe80::` address of their
 * own. Counting those as "has network" makes the check answer yes on a laptop
 * with its radio switched off, which is precisely the case it exists to catch.
 */
export function routable(address: { readonly address: string; readonly internal: boolean }): boolean {
  if (address.internal) return false
  if (address.address.startsWith("fe80:")) return false
  if (address.address.startsWith("169.254.")) return false
  return true
}

/**
 * Does the machine have any routable network interface?
 *
 * The most direct interface-level evidence there is: rather than inferring from
 * an error code, ask. A laptop with its radio off answers at once and without
 * ambiguity, which is what earns the fast path.
 *
 * It answers "is there anywhere to send a packet", NOT "does this machine have
 * internet". A machine on a LAN with no route out, or one running a tunnel
 * whose upstream is dead, still has a routable address — and answering that is
 * the probe's job, not this one's. The check is an optimisation that costs
 * nothing and sometimes saves an entire round; it is never the only evidence.
 */
export function hasNetworkInterface(): boolean {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (routable(address)) return true
    }
  }
  return false
}

/**
 * Classify a probe failure.
 *
 * "offline" is reported only when the evidence is unambiguous, because it skips
 * debouncing entirely (§3.3 快速降级). Everything else — timeouts, resets,
 * refusals, a name that would not resolve — is "other" and has to survive
 * hysteresis before it is allowed to change anything.
 *
 * `hasInterface` is a parameter rather than always being read here so a test can
 * state which world it is asking about. Left alone it reads the real one.
 */
export function classify(reason: string, hasInterface = hasNetworkInterface()): FailureKind {
  if (!hasInterface) return "offline"
  for (const code of OFFLINE_CODES) {
    if (reason.includes(code)) return "offline"
  }
  return "other"
}
