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

/**
 * Re-verify interval, the same whether a target is up or down.
 *
 * Short because it can afford to be. The probe is a TLS handshake and nothing
 * else: no subprocess, no credentials, no API path. Remote quota and abuse
 * systems key on a project and its credentials, so an unauthenticated handshake
 * never enters their view at all — which is what makes a five-second cadence a
 * question of our own cost rather than of the remote service's tolerance.
 *
 * **This justification is load-bearing.** Anyone who lengthens this interval
 * without a new reason is trading the thing the module exists for — knowing
 * quickly — against a cost that was already established to be negligible.
 *
 * Uniform across states because both directions are someone waiting: one is a
 * user whose network just broke, the other a user who has just fixed it.
 */
export const INTERVAL_MS = 5_000

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
  | {
      readonly ok: false
      readonly kind: FailureKind
      readonly detail: string
      /** Paths attempted this round, carried through to the state (§3.3). */
      readonly tried?: readonly RouteId[]
      /** Declarations that could not be attempted, credentials already stripped. */
      readonly skipped?: readonly string[]
    }

export interface Machine {
  readonly state: Reachability
  /** Consecutive failures seen while still holding a route. */
  readonly streak: number
}

export const initial: Machine = { state: { state: "idle" }, streak: 0 }

/** Apply one verdict. */
export function step(current: Machine, verdict: Verdict): Machine {
  if (verdict.ok) {
    // Recovery needs no streak. A completed handshake with the genuine endpoint
    // is not something that happens by accident, so the evidence is already
    // conclusive — unlike failure, which has many innocent causes. The
    // asymmetry is the point: slow to give up, quick to come back.
    return { state: { state: "reachable", route: verdict.routeId }, streak: 0 }
  }

  // An interface-level signal is unambiguous, so it skips the streak entirely.
  // Waiting out a debounce here would leave the application claiming to be
  // online while the machine plainly is not (§3.3 快速降级).
  if (verdict.kind === "offline") {
    return { state: unreachable(verdict), streak: 0 }
  }

  const streak = current.streak + 1
  if (streak < FAILURE_STREAK && current.state.state === "reachable") {
    // Hold the current conclusion. The failure is recorded but not yet acted on.
    return { state: current.state, streak }
  }

  return { state: unreachable(verdict), streak }
}

/**
 * The unreachable state, built in one place.
 *
 * Two exits reached it and each spelled it out, which is how one of them ends
 * up carrying a field the other forgot — and `tried` / `skipped` are exactly
 * the kind of field that goes missing without anything failing.
 */
function unreachable(verdict: Verdict & { ok: false }): Reachability {
  return {
    state: "unreachable",
    detail: verdict.detail,
    ...(verdict.tried ? { tried: verdict.tried } : {}),
    ...(verdict.skipped && verdict.skipped.length > 0 ? { skipped: verdict.skipped } : {}),
  }
}

/** How long to wait before the next round. */
export function interval(_machine: Machine): number {
  return INTERVAL_MS
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
