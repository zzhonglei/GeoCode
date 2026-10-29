import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Status } from "../../src/status.ts"

// Guards against a check a newer one overtook having the last word, as a QGIS path changed mid-check would show the
// one no longer in use as ready.
test("a commit from a round a newer claim voided is dropped", async () => {
  const [stale, current] = await Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* Status.Service
      const writer = yield* status.register("probe", "checking")
      const first = yield* writer.claim()
      const second = yield* writer.claim()
      yield* writer.commit(second, "missing")
      return [yield* writer.commit(first, "ready"), yield* status.current("probe")] as const
    }).pipe(Effect.provide(Status.layer)),
  )
  assert.deepEqual([stale, current], [false, "missing"])
})
