export * as GeoClocks from "./clocks"

import { Effect, Ref } from "effect"

/* --- GeoCode: one polling watchdog for Runtime's clocks and liveness check, rather than a timer reset per chunk
 * (docs/GEOKERNEL.md §3.2). --- */

/** Not a caller option: it is the precision of the termination machinery, not a property of the task. */
const POLL_MS = 100

export type Verdict = "timeout" | "idle" | "crash" | "output-limit"

export interface Input {
  /** Written at output ARRIVAL, not after the consumer finishes — else a slow consumer spends the idle budget. */
  readonly lastActivity: Ref.Ref<number>
  readonly accumulated?: Ref.Ref<number>
  readonly startedAt: number
  readonly totalMs?: number
  readonly idleMs?: number
  readonly outputLimit?: number
  readonly isRunning?: Effect.Effect<boolean>
  readonly now: () => number
}

/** Runs until a condition trips and never returns otherwise — the caller races it against exit and the stop signals. */
export const watch = (input: Input): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(POLL_MS)

      // Liveness first: a process that died and then fell silent is a crash, not an idle stop.
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
