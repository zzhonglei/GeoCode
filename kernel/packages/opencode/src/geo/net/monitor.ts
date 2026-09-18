export * as NetMonitor from "./monitor"

import type { FailureKind, Reachability, RouteId } from "./types"

/* --- GeoCode: the connectivity state machine, whose rhythm, thresholds and recovery policy are never copied into a
 * consumer (docs/GEOKERNEL.md §3.3). --- */

/** Short because a probe is a bare TLS handshake with no credentials or API path; lengthening it needs a new reason. */
export const INTERVAL_MS = 5_000

/** Consecutive ambiguous failures required to give up a working route. */
export const FAILURE_STREAK = 2

export type Verdict =
  | { readonly ok: true; readonly routeId: RouteId }
  | {
      readonly ok: false
      readonly kind: FailureKind
      readonly detail: string
      readonly tried?: readonly RouteId[]
      readonly skipped?: readonly string[]
    }

export interface Machine {
  readonly state: Reachability
  /** Consecutive non-offline failures; the count only matters while the state is still reachable. */
  readonly streak: number
}

export const initial: Machine = { state: { state: "idle" }, streak: 0 }

export function step(current: Machine, verdict: Verdict): Machine {
  if (verdict.ok) {
    // No streak for recovery: a completed handshake with the genuine endpoint does not happen by accident.
    return { state: { state: "reachable", route: verdict.routeId }, streak: 0 }
  }

  // Unambiguous, so it skips the streak rather than claim online while the machine plainly is not.
  if (verdict.kind === "offline") {
    return { state: unreachable(verdict), streak: 0 }
  }

  const streak = current.streak + 1
  if (streak < FAILURE_STREAK && current.state.state === "reachable") {
    return { state: current.state, streak }
  }

  return { state: unreachable(verdict), streak }
}

/** One builder for both exits, since nothing flags an omitted `tried` or `skipped`. */
function unreachable(verdict: Verdict & { ok: false }): Reachability {
  return {
    state: "unreachable",
    detail: verdict.detail,
    ...(verdict.tried ? { tried: verdict.tried } : {}),
    ...(verdict.skipped && verdict.skipped.length > 0 ? { skipped: verdict.skipped } : {}),
  }
}

/** The same in every state: both directions have someone waiting, one for a break and one for a fix. */
export function interval(_machine: Machine): number {
  return INTERVAL_MS
}

/** No route means the whole candidate flow reruns, which is how a proxy started later gets picked up. */
export function shouldRediscover(machine: Machine): boolean {
  return machine.state.state !== "reachable"
}
