export * as NetClassifier from "./classifier"

import os from "node:os"
import type { FailureKind } from "./types"

/* --- GeoCode: telling one kind of network failure from another (docs/GEOKERNEL.md §3.3). --- */

/** Interface-level and unambiguous. Host-level codes stay out: an unreachable host can be one bad service. */
const OFFLINE_CODES = ["ENETDOWN", "ENETUNREACH"]

/**
 * Link-local does not count: macOS always carries `awdl0` and `llw0` for AirDrop, and idle tunnels keep an
 * `fe80::` of their own, so counting them answers yes on a laptop with its radio switched off.
 */
export function routable(address: { readonly address: string; readonly internal: boolean }): boolean {
  if (address.internal) return false
  if (address.address.startsWith("fe80:")) return false
  if (address.address.startsWith("169.254.")) return false
  return true
}

/** Answers "is there anywhere to send a packet", not "does this machine have internet" — that is the probe's job. */
export function hasNetworkInterface(): boolean {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (routable(address)) return true
    }
  }
  return false
}

/** "offline" skips the monitor's failure streak, so it is reported only on unambiguous evidence. */
export function classify(reason: string, hasInterface = hasNetworkInterface()): FailureKind {
  if (!hasInterface) return "offline"
  for (const code of OFFLINE_CODES) {
    if (reason.includes(code)) return "offline"
  }
  return "other"
}
