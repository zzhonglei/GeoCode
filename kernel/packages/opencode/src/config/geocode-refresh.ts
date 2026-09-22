/* --- GeoCode: config disposal must exclude real execution, not a lossy copy of its SSE status (docs/DESKTOP.md §5.2). --- */
import { Effect, Schema } from "effect"

export class Busy extends Schema.TaggedErrorClass<Busy>()("GeoCodeRefreshBusy", { message: Schema.String }) {}

export const make = () => {
  const observers = new Set<Effect.Effect<boolean>>()
  let refreshing = false
  let admissions = 0
  let revision = 0

  const admit = <A, E, R>(work: Effect.Effect<A, E, R>, current = () => true) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (refreshing || !current()) throw new Error("GeoCode configuration changed or is being applied. Try again.")
        admissions++
        revision++
      }),
      () => work,
      () =>
        Effect.sync(() => {
          admissions--
          revision++
        }),
    )

  const observe = (busy: Effect.Effect<boolean>) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let current = true
        observers.add(busy)
        revision++
        return {
          admit: <A, E, R>(work: Effect.Effect<A, E, R>) => admit(work, () => current),
          close: Effect.sync(() => {
            current = false
          }),
          remove: Effect.sync(() => {
            current = false
            observers.delete(busy)
            revision++
          }),
        }
      }),
      (observer) => observer.remove,
    )

  const watchRunners = Effect.gen(function* () {
    const running = new Set<{ readonly busy: boolean }>()
    const observer = yield* observe(Effect.sync(() => [...running].some((runner) => runner.busy)))
    const update = (runner: { readonly busy: boolean }) => {
      if (runner.busy) running.add(runner)
      else running.delete(runner)
    }
    return {
      close: observer.close,
      idle: update,
      // Track the actual admitted runner, even if an old idle callback removed its upstream lookup entry.
      admit: <A, E, R>(runner: { readonly busy: boolean }, work: Effect.Effect<A, E, R>) =>
        observer.admit(work.pipe(Effect.ensuring(Effect.sync(() => update(runner))))),
    }
  })

  const refresh = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const before = revision
        const busy = yield* Effect.forEach([...observers], (read) => read)
        // Do not close admission while reading: an existing background job may still be entering its runner.
        return yield* Effect.suspend(() => {
          if (refreshing || admissions > 0 || before !== revision || busy.some(Boolean)) {
            return Effect.fail(
              new Busy({ message: "Work is still running or starting. Wait for it to finish, then apply again." }),
            )
          }
          refreshing = true
          return Effect.void
        })
      }),
      () => work,
      () =>
        Effect.sync(() => {
          refreshing = false
        }),
    )

  return { admit, observe, watchRunners, refresh }
}

export const coordinator = make()
export * as GeoCodeRefresh from "./geocode-refresh"
