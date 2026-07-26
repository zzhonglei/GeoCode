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
 * Does the machine have any usable network interface?
 *
 * The most direct interface-level signal there is: rather than inferring from
 * an error code, ask. A laptop with WiFi switched off answers immediately and
 * without ambiguity, which is what earns the fast path.
 */
export function hasNetworkInterface(): boolean {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) return true
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
