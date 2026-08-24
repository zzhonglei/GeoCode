export * as GeoClocks from "./clocks"

import { Effect, Ref } from "effect"

/* --- GeoCode: the watchdog behind Runtime's two clocks (docs/GEOKERNEL.md §3.2 时钟语义).
 *
 * One polling loop for both clocks and the liveness check: comparing "now" against "last output at" on a fixed tick
 * costs the same at any output rate, where resetting a timer per chunk does not. Detection is accurate to one
 * tick. --- */

/** Fixed inside Runtime (§3.2 参数面): it describes the precision of the termination machinery, not the task. */
const POLL_MS = 100

export type Verdict = "timeout" | "idle" | "crash" | "output-limit"

export interface Input {
  /** Written at output ARRIVAL, not after the consumer finishes — else a slow consumer spends the idle budget. */
  readonly lastActivity: Ref.Ref<number>
  /** Bytes seen so far; only consulted when `outputLimit` is given too. */
  readonly accumulated?: Ref.Ref<number>
  readonly startedAt: number
  readonly totalMs?: number
  readonly idleMs?: number
  readonly outputLimit?: number
  /** Liveness probe, or undefined to disable it — the caller decides per platform (§3.2 异常终止识别). */
  readonly isRunning?: Effect.Effect<boolean>
  readonly now: () => number
}

/** Runs until a condition trips and never returns otherwise — the caller races it against exit and the stop signals. */
export const watch = (input: Input): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(POLL_MS)

      // Liveness first: a dead process whose output stream is held open would otherwise sit out the whole idle budget.
      if (input.isRunning) {
        const alive = yield* input.isRunning
        if (!alive) return "crash"
      }

      if (input.outputLimit !== undefined && input.accumulated) {
        const size = yield* Ref.get(input.accumulated)
        if (size > input.outputLimit) return "output-limit"
      }

      const now = input.now()

      // Idle before total: when both have elapsed, "went silent" is the more specific verdict.
      if (input.idleMs !== undefined) {
        const last = yield* Ref.get(input.lastActivity)
        if (now - last >= input.idleMs) return "idle"
      }

      if (input.totalMs !== undefined && now - input.startedAt >= input.totalMs) return "timeout"
    }
  })
