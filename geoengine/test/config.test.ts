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

test("an absent file gives each block no value", () =>
  withFile(undefined, async (file) => {
    const state = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* (yield* config.block("qgis", Location)).current
      }),
    )
    assert.deepEqual(state, { ok: true, value: undefined })
  }))

test("a block written wrong fails alone", () =>
  withFile(JSON.stringify({ qgis: { path: 3 }, gee: { path: "/opt/python" } }), async (file) => {
    const [qgis, gee] = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return [
          yield* (yield* config.block("qgis", Location)).current,
          yield* (yield* config.block("gee", Location)).current,
        ]
      }),
    )
    assert.equal(qgis.ok, false)
    // The failure has to name the block the user got wrong.
    if (!qgis.ok) assert.ok(qgis.failure.message.includes("qgis"))
    assert.deepEqual(gee, { ok: true, value: { path: "/opt/python" } })
  }))

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

test("a file still broken after another save reports the new position", () =>
  withFile(`{"qgis": `, async (file) => {
    const seen = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(block.watch, 2)))
        yield* Effect.promise(() => fs.writeFile(file, `{\n\n"qgis": [`))
        yield* config.reload()
        return yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      }),
    )
    const messages = seen.map((state) => (state.ok ? "" : state.failure.message))
    assert.ok(messages[0] && messages[1])
    assert.notEqual(messages[0], messages[1])
  }))

test("a save that only reformats is not a change", () =>
  withFile(JSON.stringify({ qgis: { path: "/a" }, other: 1 }), async (file) => {
    const seen = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(block.watch, 2)))
        yield* Effect.promise(() => fs.writeFile(file, `{\n  "other": 1,\n  "qgis": { "path": "/a" }\n}`))
        yield* config.reload()
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ qgis: { path: "/b" } })))
        yield* config.reload()
        return yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      }),
    )
    assert.deepEqual(
      seen.map((state) => state.ok && state.value),
      [{ path: "/a" }, { path: "/b" }],
    )
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

test("a watch that could not start is set up again and catches up on the edits it missed", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "geoengine-config-"))
  const file = path.join(parent, "later", "machine.json")
  try {
    const seen = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("qgis", Location)
        const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(block.watch, 2)))
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(file))
          await fs.writeFile(file, JSON.stringify({ qgis: { path: "/late" } }))
        })
        return yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
      }),
    )
    assert.deepEqual(seen[1], { ok: true, value: { path: "/late" } })
  } finally {
    await fs.rm(parent, { recursive: true, force: true })
  }
})

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

test("a write stores the encoded form, so the value reads back as written", () =>
  withFile(undefined, async (file) => {
    const state = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("gee", Schema.Struct({ version: Schema.NumberFromString }))
        yield* block.write({ version: 3 })
        return yield* block.current
      }),
    )
    assert.deepEqual(state, { ok: true, value: { version: 3 } })
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), { gee: { version: "3" } })
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

test("a leading byte order mark is accepted", () =>
  withFile(String.fromCharCode(0xfeff) + JSON.stringify({ qgis: { path: "/a" } }), async (file) => {
    const state = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* (yield* config.block("qgis", Location)).current
      }),
    )
    assert.deepEqual(state, { ok: true, value: { path: "/a" } })
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

test("an update leaves a block written wrong as it is, where a write replaces it", () =>
  withFile(JSON.stringify({ gee: { python: 3 } }), async (file) => {
    const outcome = await run(
      file,
      Effect.gen(function* () {
        const config = yield* Config.Service
        const block = yield* config.block("gee", Pair)
        const updated = yield* block.update((current) => ({ ...current, project: "q" })).pipe(Effect.exit)
        const kept = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf-8")))
        yield* block.write({ python: "/python" })
        return { updated, kept }
      }),
    )
    assert.equal(outcome.updated._tag, "Failure")
    assert.deepEqual(outcome.kept, { gee: { python: 3 } })
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), { gee: { python: "/python" } })
  }))
