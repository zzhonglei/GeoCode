import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Effect, Fiber, Schema, type Scope, Stream } from "effect"
import { Config } from "../src/config.ts"

const Location = Schema.Struct({ path: Schema.String })

const withFile = async <A>(initial: string | undefined, body: (file: string) => Promise<A>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-config-"))
  const file = path.join(directory, "machine.json")
  if (initial !== undefined) await fs.writeFile(file, initial)
  try {
    return await body(file)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const run = <A>(file: string, effect: Effect.Effect<A, unknown, Config.Service | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Config.layer(file))))

test("an unparsable file fails every block, and fixing it brings each back even when unchanged", () =>
  withFile(JSON.stringify({ qgis: { path: "/a" }, gee: { path: "/b" } }), async (file) => {
    const [qgis, gee] = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const blocks = [yield* config.block("qgis", Location), yield* config.block("gee", Location)]
        const fibers = yield* Effect.forEach(blocks, (block) =>
          Effect.forkScoped(Stream.runCollect(Stream.take(block.watch, 3))),
        )
        yield* Effect.promise(() => fs.writeFile(file, `{"qgis": {"path": "/a"`))
        yield* config.reload()
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ qgis: { path: "/a" }, gee: { path: "/b" } })))
        yield* config.reload()
        return yield* Effect.forEach(fibers, Fiber.join).pipe(Effect.timeout("5 seconds"))
      }),
    )
    for (const [seen, value] of [
      [qgis!, { path: "/a" }],
      [gee!, { path: "/b" }],
    ] as const) {
      assert.deepEqual(seen[0], { ok: true, value })
      assert.equal(seen[1]!.ok, false)
      if (!seen[1]!.ok) assert.equal(seen[1]!.failure.file, file)
      assert.deepEqual(seen[2], { ok: true, value })
    }
  }))

test("an edit made outside the engine is picked up by the watch", () =>
  withFile("{}", async (file) => {
    const seen = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(block.watch, 2)))
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ qgis: { path: "/edited" } })))
        return yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      }),
    )
    assert.deepEqual(seen[1], { ok: true, value: { path: "/edited" } })
  }))

test("a write keeps the other blocks and unknown keys, and leaves no temporary file", () =>
  withFile(JSON.stringify({ gee: { path: "/python" }, note: "kept" }), async (file) => {
    const state = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        yield* block.write({ path: "/qgis" })
        return yield* block.current
      }),
    )
    assert.deepEqual(state, { ok: true, value: { path: "/qgis" } })
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), {
      gee: { path: "/python" },
      note: "kept",
      qgis: { path: "/qgis" },
    })
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["machine.json"])
  }))

test("a write is refused while the file cannot be parsed, and the file is left as it is", () =>
  withFile(`{"qgis": // a note\n}`, async (file) => {
    const outcome = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        return yield* block.write({ path: "/qgis" }).pipe(Effect.exit)
      }),
    )
    assert.equal(outcome._tag, "Failure")
    assert.equal(await fs.readFile(file, "utf-8"), `{"qgis": // a note\n}`)
  }))

const Pair = Schema.Struct({ python: Schema.optionalKey(Schema.String), project: Schema.optionalKey(Schema.String) })

// Guards against a setting saved in the interface dropping one GeoAgent wrote a moment before, not yet read back.
test("an update changes the block as the file holds it, keeping what was written elsewhere since", () =>
  withFile(JSON.stringify({ gee: { project: "p" } }), async (file) => {
    const state = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("gee", Pair)
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ gee: { project: "p", python: "/python" } })))
        yield* block.update((current) => ({ ...current, project: "q" }))
        return yield* block.current
      }),
    )
    assert.deepEqual(state, { ok: true, value: { project: "q", python: "/python" } })
  }))
