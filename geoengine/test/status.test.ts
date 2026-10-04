import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Fiber, Stream } from "effect"
import { Status } from "../src/status.ts"

const run = <A>(effect: Effect.Effect<A, unknown, Status.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Status.layer)))

test("registering a domain publishes its initial value to an earlier subscriber", async () => {
  const seen = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const status = yield* Status.Service
        const changes = yield* status.changes
        yield* status.register("qgis", { status: "checking" })
        return yield* Stream.runCollect(Stream.take(changes, 1)).pipe(Effect.timeout("5 seconds"))
      }),
    ),
  )
  assert.deepEqual(seen, [{ domain: "qgis", value: { status: "checking" } }])
})

test("a commit from an earlier round is dropped", async () => {
  const value = await run(
    Effect.gen(function* () {
      const status = yield* Status.Service
      const writer = yield* status.register("qgis", { status: "checking" })
      const stale = yield* writer.claim()
      const fresh = yield* writer.claim()
      assert.equal(yield* writer.commit(fresh, { status: "ready" }), true)
      assert.equal(yield* writer.commit(stale, { status: "failed" }), false)
      return yield* status.current("qgis")
    }),
  )
  assert.deepEqual(value, { status: "ready" })
})

test("an unchanged value is not published again", async () => {
  const seen = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const status = yield* Status.Service
        const writer = yield* status.register("qgis", { status: "checking" })
        const changes = yield* status.changes
        const token = yield* writer.claim()
        yield* writer.commit(token, { status: "ready" })
        yield* writer.commit(token, { status: "ready" })
        yield* writer.commit(token, { status: "failed" })
        return yield* Stream.runCollect(Stream.take(changes, 2)).pipe(Effect.timeout("5 seconds"))
      }),
    ),
  )
  assert.deepEqual(
    seen.map((change) => change.value),
    [{ status: "ready" }, { status: "failed" }],
  )
})

test("watch starts from the current value and follows changes", async () => {
  const seen = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const status = yield* Status.Service
        const writer = yield* status.register("gee", { status: "checking" })
        const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(status.watch("gee"), 2)))
        yield* Effect.sleep("50 millis")
        yield* writer.commit(yield* writer.claim(), { status: "ready" })
        return yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      }),
    ),
  )
  assert.deepEqual(seen, [{ status: "checking" }, { status: "ready" }])
})

test("registering a domain twice is a defect", async () => {
  await assert.rejects(
    run(
      Effect.gen(function* () {
        const status = yield* Status.Service
        yield* status.register("qgis", 1)
        yield* status.register("qgis", 2)
      }),
    ),
  )
})
