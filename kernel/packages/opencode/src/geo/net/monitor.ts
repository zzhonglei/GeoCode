export * as NetMonitor from "./monitor"

import type { FailureKind, Reachability, RouteId } from "./types"

/* --- GeoCode: the connectivity state machine (docs/GEOKERNEL.md §3.3 监视).
 *
 * This is the ONLY place connectivity changes state. Consumers read the
 * conclusion and copy none of the rhythm, thresholds or recovery policy into
 * themselves (§8.3) — which only holds if all of it lives here.
 *
 * The transition is a pure function so the two rules that are easy to get
 * subtly wrong — hysteresis and the fast path around it — can be examined
 * without a network. --- */

/** Re-verify interval while a target is reachable. */
export const HEALTHY_INTERVAL_MS = 30_000

/**
 * Re-verify interval while it is not.
 *
 * Shorter than the healthy one on purpose: this is the window in which a user
 * who has just started their proxy software is waiting for the application to
 * notice, and noticing is supposed to need no interaction from them at all.
 */
export const DEGRADED_INTERVAL_MS = 10_000

/**
 * Consecutive ambiguous failures required to give up a working route.
 *
 * Above one because timeouts and resets are what a flapping link produces, and
 * flipping on the first of them makes the indicator blink instead of inform.
 */
export const FAILURE_STREAK = 2

/** What one round of probing concluded. */
export type Verdict =
  | { readonly ok: true; readonly routeId: RouteId }
  | { readonly ok: false; readonly kind: FailureKind; readonly detail: string }

export interface Machine {
  readonly state: Reachability
  /** Consecutive failures seen while still holding a route. */
  readonly streak: number
}

export interface Step {
  readonly next: Machine
  /**
   * Whether endpoint rankings for this target must be discarded.
   *
   * The rule is one line and covers every case §3.3 lists: **the ranking dies
   * whenever the route identity changes**, counting "no route" as an identity
   * of its own. A proxy appearing, a proxy disappearing, a switch from one
   * route to another, connectivity lost, connectivity regained — each is a
   * change of identity, and each means the measurements were taken under
   * conditions that no longer hold. A re-verify that concludes what it
   * concluded last time changes nothing and invalidates nothing.
   */
  readonly invalidateRanking: boolean
}

export const initial: Machine = { state: { state: "idle" }, streak: 0 }

function identity(state: Reachability): RouteId | undefined {
  return state.state === "reachable" ? state.route : undefined
}

/** Apply one verdict. */
export function step(current: Machine, verdict: Verdict): Step {
  const before = identity(current.state)

  if (verdict.ok) {
    // Recovery needs no streak. A completed handshake with the genuine endpoint
    // is not something that happens by accident, so the evidence is already
    // conclusive — unlike failure, which has many innocent causes. The
    // asymmetry is the point: slow to give up, quick to come back.
    const next: Machine = { state: { state: "reachable", route: verdict.routeId }, streak: 0 }
    return { next, invalidateRanking: before !== verdict.routeId }
  }

  // An interface-level signal is unambiguous, so it skips the streak entirely.
  // Waiting out a debounce here would leave the application claiming to be
  // online while the machine plainly is not (§3.3 快速降级).
  if (verdict.kind === "offline") {
    const next: Machine = { state: { state: "unreachable", detail: verdict.detail }, streak: 0 }
    return { next, invalidateRanking: before !== undefined }
  }

  const streak = current.streak + 1
  if (streak < FAILURE_STREAK && current.state.state === "reachable") {
    // Hold the current conclusion. The failure is recorded but not yet acted on.
    return { next: { state: current.state, streak }, invalidateRanking: false }
  }

  const next: Machine = { state: { state: "unreachable", detail: verdict.detail }, streak }
  return { next, invalidateRanking: before !== undefined }
}

/** How long to wait before the next round. */
export function interval(machine: Machine): number {
  return machine.state.state === "reachable" ? HEALTHY_INTERVAL_MS : DEGRADED_INTERVAL_MS
}

/**
 * Should the next round re-verify the route in hand, or search from scratch?
 *
 * Losing reachability clears the route, so recovery goes through the whole
 * candidate flow again. That is what lets a proxy the user has just started be
 * picked up on its own, with nothing to click (§3.3 自动恢复).
 */
export function shouldRediscover(machine: Machine): boolean {
  return machine.state.state !== "reachable"
}
