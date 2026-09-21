/* --- GeoCode: config apply must not dispose work hidden by missing SSE events or caller cancellation. --- */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GeoCodeRefresh } from "@/config/geocode-refresh"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const refused = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  )

const makeRunner = Effect.fnUntraced(function* (refresh: ReturnType<typeof GeoCodeRefresh.make>) {
  const runners: Runner.Runner<string>[] = []
  const observer = yield* refresh.observe(Effect.sync(() => runners.some((runner) => runner.busy)))
  const runner = Runner.make<string>(yield* Scope.Scope, { admit: observer.admit })
  runners.push(runner)
  return runner
})

describe("GeoCode: atomic config refresh", () => {
  it.live("retains busy protection when a caller disconnects from a running fiber", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const runner = yield* makeRunner(refresh)
      const started = yield* Deferred.make<void>()
      const done = yield* Deferred.make<string>()
      const caller = yield* runner
        .ensureRunning(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      expect(runner.busy).toBe(true)
      let disposed = false
      yield* refused(
        refresh.refresh(
          Effect.sync(() => {
            disposed = true
          }),
        ),
      )
      expect(disposed).toBe(false)
      yield* runner.cancel
      expect(yield* refresh.refresh(Effect.succeed("idle"))).toBe("idle")
    }),
  )

  it.live("refuses disposal during admission before a busy state exists", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const admitted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const transition = yield* refresh
        .admit(Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(admitted)
      yield* refused(refresh.refresh(Effect.void))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(transition)
      yield* refresh.refresh(Effect.void)
    }),
  )

  it.live("rejects both runner entry points while disposal holds admission", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const runner = yield* makeRunner(refresh)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const disposal = yield* refresh
        .refresh(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      let calls = 0
      const work = Effect.sync(() => {
        calls++
        return "ran"
      })
      yield* refused(runner.ensureRunning(work))
      yield* refused(runner.startShell(work))
      expect(calls).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(disposal)
      expect(yield* runner.ensureRunning(work)).toBe("ran")
    }),
  )

  it.live("does not block existing work during async inspection and rejects a stale snapshot", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const reading = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* refresh.observe(
        Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(false)),
      )
      let disposed = false
      const result = yield* refresh
        .refresh(
          Effect.sync(() => {
            disposed = true
          }),
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(reading)
      expect(yield* refresh.admit(Effect.succeed("work allowed"))).toBe("work allowed")
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(result))).toBe(true)
      expect(disposed).toBe(false)
    }),
  )

  it.live("releases refresh after errors and rejects admission through a closed instance", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const observer = yield* refresh.observe(Effect.succeed(false))
      yield* refused(refresh.refresh(Effect.fail("dispose failed")))
      expect(yield* observer.admit(Effect.succeed("open"))).toBe("open")
      yield* observer.close
      yield* refused(observer.admit(Effect.succeed("must not enter")))
      expect(yield* refresh.refresh(Effect.succeed("retry"))).toBe("retry")
    }),
  )

  it.live("keeps a shell and its queued loop protected until both finish", () =>
    Effect.gen(function* () {
      const refresh = GeoCodeRefresh.make()
      const runner = yield* makeRunner(refresh)
      const started = yield* Deferred.make<void>()
      const shellDone = yield* Deferred.make<string>()
      const loopStarted = yield* Deferred.make<void>()
      const shell = yield* runner
        .startShell(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(shellDone))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const loop = yield* runner
        .ensureRunning(Deferred.succeed(loopStarted, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild)
      yield* refused(refresh.refresh(Effect.void))
      yield* Deferred.succeed(shellDone, "shell")
      yield* Fiber.join(shell)
      yield* Deferred.await(loopStarted)
      yield* refused(refresh.refresh(Effect.void))
      yield* Fiber.interrupt(loop)
      yield* runner.cancel
      yield* refresh.refresh(Effect.void)
    }),
  )
})

const integration = testEffect(
  LayerNode.compile(LayerNode.group([SessionRunState.node, BackgroundJob.node]), [
    [SessionStatus.node, Layer.mock(SessionStatus.Service)({ set: () => Effect.void })],
  ]),
)

describe("GeoCode: production execution registration without SSE", () => {
  integration.instance("real session runners remain protected after their caller leaves", () =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const started = yield* Deferred.make<void>()
      const id = SessionID.make("ses_refresh_test")
      const caller = yield* state
        .ensureRunning(id, Effect.never, Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      yield* refused(GeoCodeRefresh.coordinator.refresh(Effect.void))
      yield* state.cancel(id)
      yield* GeoCodeRefresh.coordinator.refresh(Effect.void)
    }),
  )

  integration.instance("background jobs protect queued extensions without a child runner", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const done = yield* Deferred.make<string>()
      const job = yield* jobs.start({ type: "refresh-test", run: Deferred.await(done) })
      yield* jobs.extend({ id: job.id, run: Effect.never })
      yield* refused(GeoCodeRefresh.coordinator.refresh(Effect.void))
      yield* Deferred.succeed(done, "first complete")
      yield* refused(GeoCodeRefresh.coordinator.refresh(Effect.void))
      yield* jobs.cancel(job.id)
      yield* GeoCodeRefresh.coordinator.refresh(Effect.void)
    }),
  )
})
