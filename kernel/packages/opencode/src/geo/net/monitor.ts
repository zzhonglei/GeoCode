export * as NetMonitor from "./monitor"

import type { FailureKind, Reachability, RouteId } from "./types"

/* --- GeoCode: the connectivity state machine — the only place connectivity changes state, so the rhythm, thresholds
 * and recovery policy are never copied into a consumer (docs/GEOKERNEL.md §3.3 监视, §8.3). --- */

/**
 * Re-verify interval. Short because the probe is an unauthenticated handshake that never enters a remote quota or
 * abuse system's view, so the cost is only ours; lengthening it needs a new reason (§3.3).
 */
export const INTERVAL_MS = 5_000

/** Consecutive ambiguous failures required to give up a working route. */
export const FAILURE_STREAK = 2

export type Verdict =
  | { readonly ok: true; readonly routeId: RouteId }
  | {
      readonly ok: false
      readonly kind: FailureKind
      readonly detail: string
      /** Paths attempted this round, carried through to the state (§3.3). */
      readonly tried?: readonly RouteId[]
      /** Declarations that could not be attempted, credentials never taken rather than stripped. */
      readonly skipped?: readonly string[]
    }

export interface Machine {
  readonly state: Reachability
  /** Consecutive failures seen while still holding a route. */
  readonly streak: number
}

export const initial: Machine = { state: { state: "idle" }, streak: 0 }

export function step(current: Machine, verdict: Verdict): Machine {
  if (verdict.ok) {
    // Recovery needs no streak of its own: a completed handshake with the genuine endpoint does not happen by
    // accident, while failure has many innocent causes. Slow to give up, quick to come back.
    return { state: { state: "reachable", route: verdict.routeId }, streak: 0 }
  }

  // Unambiguous, so it skips the streak: debouncing it would leave the application claiming to be online while the
  // machine plainly is not (§3.3 快速降级).
  if (verdict.kind === "offline") {
    return { state: unreachable(verdict), streak: 0 }
  }

  const streak = current.streak + 1
  if (streak < FAILURE_STREAK && current.state.state === "reachable") {
    return { state: current.state, streak }
  }

  return { state: unreachable(verdict), streak }
}

/** Both exits build the state here, so neither can forget `tried` or `skipped` — a loss nothing else would report. */
function unreachable(verdict: Verdict & { ok: false }): Reachability {
  return {
    state: "unreachable",
    detail: verdict.detail,
    ...(verdict.tried ? { tried: verdict.tried } : {}),
    ...(verdict.skipped && verdict.skipped.length > 0 ? { skipped: verdict.skipped } : {}),
  }
}

/** Takes the machine and ignores it: both directions are someone waiting, one for a break and one for a fix. */
export function interval(_machine: Machine): number {
  return INTERVAL_MS
}

/** No route means recovery reruns the whole candidate flow, picking up a proxy just started (§3.3 自动恢复). */
export function shouldRediscover(machine: Machine): boolean {
  return machine.state.state !== "reachable"
}
