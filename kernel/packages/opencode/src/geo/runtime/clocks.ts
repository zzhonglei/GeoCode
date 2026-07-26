export * as GeoClocks from "./clocks"

import { Effect, Ref } from "effect"

/* --- GeoCode: the watchdog behind Runtime's two clocks (docs/GEOKERNEL.md §3.2).
 *
 * One polling loop serves both clocks plus the liveness check, rather than a
 * timer per clock. The design reason is in "时钟语义": a task can emit thousands
 * of chunks a second, and resetting a timer on each one costs real work, while
 * comparing "now" against "last output at" on a fixed tick costs the same
 * regardless of output rate. The price is that detection is accurate only to
 * within one tick, which is irrelevant for limits measured in seconds. --- */

/**
 * Poll interval. Fixed inside Runtime (§3.2): it describes the precision of the
 * termination machinery, not anything about the task, so exposing it would add
 * a concept callers have to understand without improving any decision they make.
 */
const POLL_MS = 100

export type Verdict = "timeout" | "idle" | "crash" | "output-limit"

export interface Input {
  /** Timestamp of the most recent output arrival — written at ARRIVAL, not after the consumer finishes. */
  readonly lastActivity: Ref.Ref<number>
  /** Bytes accumulated so far in collect mode; undefined when nothing is accumulating. */
  readonly accumulated?: Ref.Ref<number>
  readonly startedAt: number
  readonly totalMs?: number
  readonly idleMs?: number
  readonly outputLimit?: number
  /**
   * Liveness probe, or undefined to disable it.
   *
   * Disabled is not a degraded mode: on some platforms a normally exiting
   * process transiently reports as not-running, and enabling the check there
   * turns successfully completed long tasks into false crash reports. The
   * caller decides per platform (§3.2 "异常终止识别").
   */
  readonly isRunning?: Effect.Effect<boolean>
  readonly now: () => number
}

/**
 * Run until one of the conditions trips. Never returns otherwise — the caller
 * races this against process exit and the interrupt signal.
 */
export const watch = (input: Input): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(POLL_MS)

      // Liveness first. A process that has already died but whose output stream
      // stays open (a crash reporter inherited the handle) would otherwise sit
      // silent until the idle clock ran out — waiting the entire budget to
      // discover something already knowable.
      if (input.isRunning) {
        const alive = yield* input.isRunning
        if (!alive) return "crash"
      }

      if (input.outputLimit !== undefined && input.accumulated) {
        const size = yield* Ref.get(input.accumulated)
        if (size > input.outputLimit) return "output-limit"
      }

      const now = input.now()

      // Idle is checked before total: when both have elapsed, "went silent" is
      // the more specific description of what happened, and it is the one that
      // tells the user something actionable.
      if (input.idleMs !== undefined) {
        const last = yield* Ref.get(input.lastActivity)
        if (now - last >= input.idleMs) return "idle"
      }

      if (input.totalMs !== undefined && now - input.startedAt >= input.totalMs) return "timeout"
    }
  })
