export * as Config from "./config.ts"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Exit, Layer, PubSub, Schema, Semaphore, Stream } from "effect"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/** One save reaches the watcher more than once, and a read landing mid-write sees a file nobody saved. */
const DEBOUNCE_MS = 100

/** A watch that failed or broke is set up again after this, since nothing else would ever notice it is gone. */
const WATCH_RETRY_MS = 5000

export interface Failure {
  readonly file: string
  readonly message: string
}

/** An absent block is `ok` with no value; a block written wrong fails alone, an unparsable file fails them all. */
export type BlockState<A> =
  | { readonly ok: true; readonly value: A | undefined }
  | { readonly ok: false; readonly failure: Failure }

export interface Block<A> {
  readonly current: Effect.Effect<BlockState<A>>
  /** The current state, then each change to this block's parsed value. */
  readonly watch: Stream.Stream<BlockState<A>>
  /** Refused while the file cannot be read or parsed, so a hand-written file is never overwritten. */
  readonly write: (value: A) => Effect.Effect<void, Error>
  /**
   * Writes what `change` makes of the block as the file holds it at that moment, so a change made elsewhere since the
   * last read is kept; refused as `write` is, and while the block itself is written wrong.
   */
  readonly update: (change: (current: A | undefined) => A) => Effect.Effect<void, Error>
}

export interface Interface {
  /** The file's absolute path. */
  readonly file: string
  /** Registers a domain's block under its own name; twice is a defect. */
  readonly block: <S extends Schema.Codec<unknown, unknown>>(name: string, schema: S) => Effect.Effect<Block<S["Type"]>>
  /** Reads the file now: for after a write elsewhere, and for when the watch has died. */
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoEngine/Config") {}

type Loaded =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly failure: Failure }

interface Entry {
  readonly name: string
  readonly decode: (raw: unknown) => BlockState<unknown>
  state: BlockState<unknown>
  canonical: string
  readonly pubsub: PubSub.PubSub<BlockState<unknown>>
}

export const layer = (file: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const entries = new Map<string, Entry>()
      let loaded: Loaded = { ok: true, data: {} }
      // Unserialized, an older read could land after a newer one and leave a domain on stale configuration.
      const serialized = Semaphore.makeUnsafe(1)

      const failed = (failure: Failure): BlockState<unknown> => ({ ok: false, failure })

      const apply = (next: Loaded) =>
        Effect.gen(function* () {
          loaded = next
          for (const entry of entries.values()) {
            const raw = next.ok ? next.data[entry.name] : undefined
            // Failure is part of the comparison, so recovery always re-dispatches and a file still broken after
            // another save reports where it is broken now.
            const canonical = next.ok ? canonicalOf(raw) : UNPARSABLE + next.failure.message
            if (canonical === entry.canonical) continue
            entry.canonical = canonical
            entry.state = next.ok ? entry.decode(raw) : failed(next.failure)
            yield* PubSub.publish(entry.pubsub, entry.state)
          }
        })

      const reload = () => serialized.withPermits(1)(Effect.promise(() => load(file)).pipe(Effect.flatMap(apply)))

      const block = <S extends Schema.Codec<unknown, unknown>>(name: string, schema: S) =>
        Effect.gen(function* () {
          if (entries.has(name)) return yield* Effect.die(new Error(`machine.json block registered twice: ${name}`))
          const decodeValue = Schema.decodeUnknownExit(schema)
          const encodeValue = Schema.encodeUnknownExit(schema)
          const decode = (raw: unknown): BlockState<unknown> => {
            if (raw === undefined) return { ok: true, value: undefined }
            const exit = decodeValue(raw)
            if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
            return failed({ file, message: `"${name}": ${messageOf(Cause.squash(exit.cause))}` })
          }
          const raw = loaded.ok ? loaded.data[name] : undefined
          const entry: Entry = {
            name,
            decode,
            state: loaded.ok ? decode(raw) : failed(loaded.failure),
            canonical: loaded.ok ? canonicalOf(raw) : UNPARSABLE + loaded.failure.message,
            pubsub: yield* PubSub.unbounded<BlockState<unknown>>(),
          }
          entries.set(name, entry)

          const watch = Stream.unwrap(
            Effect.gen(function* () {
              // Subscribed before reading, or a change landing between the two is lost to both.
              const subscription = yield* PubSub.subscribe(entry.pubsub)
              return Stream.make(entry.state).pipe(Stream.concat(Stream.fromSubscription(subscription)))
            }),
          ) as Stream.Stream<BlockState<S["Type"]>>

          /** Writes the value made from the block's raw form in the file as read under the lock. */
          const save = (valueOf: (raw: unknown) => Exit.Exit<S["Type"], Error>) =>
            serialized.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Effect.promise(() => load(file))
                if (!current.ok) {
                  return yield* Effect.fail(new Error(`${file} cannot be read or parsed, so it is left as it is`))
                }
                const value = valueOf(current.data[name])
                if (Exit.isFailure(value)) return yield* value
                // The file holds the encoded form, which the next read decodes.
                const encoded = encodeValue(value.value)
                if (Exit.isFailure(encoded)) {
                  return yield* Effect.fail(new Error(`"${name}": ${messageOf(Cause.squash(encoded.cause))}`))
                }
                const data = { ...current.data, [name]: encoded.value }
                yield* Effect.tryPromise({
                  try: () => replace(file, JSON.stringify(data, null, 2) + "\n"),
                  catch: (error) => (error instanceof Error ? error : new Error(String(error))),
                })
                yield* apply(yield* Effect.promise(() => load(file)))
              }),
            )

          // Over a block written wrong too: writing a right one is how it gets fixed.
          const write = (value: S["Type"]) => save(() => Exit.succeed(value))

          const update = (change: (current: S["Type"] | undefined) => S["Type"]) =>
            save((raw) => {
              const held = decode(raw)
              return held.ok
                ? Exit.succeed(change(held.value))
                : Exit.fail(new Error(`${held.failure.message}, so it is left as it is`))
            })

          return {
            current: Effect.sync(() => entry.state as BlockState<S["Type"]>),
            watch,
            write,
            update,
          } satisfies Block<S["Type"]>
        })

      // Watched before the first read, or a save landing between the two is seen by neither.
      const context = yield* Effect.context<never>()
      const runFork = Effect.runForkWith(context)
      const watcher = watchDirectory(
        file,
        () => runFork(reload()),
        (cause) => runFork(Effect.logWarning("machine.json watch failed", cause)),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()))
      yield* reload()

      return Service.of({ file, block, reload })
    }),
  )

/** Not valid JSON, so neither collides with a real value. */
const ABSENT = "<absent>"
const UNPARSABLE = "<unparsable>"

/** Key order removed, so a save that only reformats produces no change. */
function canonicalOf(value: unknown): string {
  if (value === undefined) return ABSENT
  return JSON.stringify(sort(value))
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sort(record[key])]),
    )
  }
  return value
}

/** A read error fails like a syntax error rather than throwing, which would stop the engine starting. */
async function load(file: string): Promise<Loaded> {
  const read = await readTolerantly(file).then(
    (text) => ({ ok: true as const, text: text ?? "" }),
    (error: unknown) => ({ ok: false as const, message: messageOf(error) }),
  )
  if (!read.ok) return { ok: false, failure: { file, message: read.message } }
  // An editor may save a byte order mark, which the parser rejects.
  const stripped = read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text
  if (!stripped.trim()) return { ok: true, data: {} }
  // Not JSON.parse: not all of its errors carry a line and column, and some quote the file's text instead.
  const errors: ParseError[] = []
  const data: unknown = parse(stripped, errors, { disallowComments: true, allowTrailingComma: false })
  const first = errors[0]
  if (first) {
    const before = stripped.slice(0, first.offset).split("\n")
    const where = `line ${before.length}, column ${before.at(-1)!.length + 1}`
    return { ok: false, failure: { file, message: `${printParseErrorCode(first.error)} at ${where}` } }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, failure: { file, message: "machine.json must hold a JSON object" } }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

/** One retry: on Windows an indexer or antivirus can hold a just-saved file for a few milliseconds. */
async function readTolerantly(file: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.readFile(file, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      if (attempt >= 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
}

/**
 * Written beside the target and renamed over it, so the file is never left half written. One fixed temporary name,
 * since writes are serialized: one left by a crash is simply overwritten by the next write.
 */
async function replace(file: string, text: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await fsp.writeFile(temporary, text, "utf-8")
  // One retry, for the same Windows indexer or antivirus that readTolerantly waits out.
  await fsp
    .rename(temporary, file)
    .catch(() => new Promise((resolve) => setTimeout(resolve, 60)).then(() => fsp.rename(temporary, file)))
    .catch(async (error: unknown) => {
      await fsp.rm(temporary, { force: true })
      throw error
    })
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** The directory, not the file: editors that save by renaming over the target detach a watch on the file itself. */
function watchDirectory(file: string, onChange: () => void, onError: (cause: unknown) => void) {
  const name = path.basename(file)
  let timer: NodeJS.Timeout | undefined
  let retry: NodeJS.Timeout | undefined
  let watcher: fs.FSWatcher | undefined
  let failing = false
  let closed = false
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, DEBOUNCE_MS)
  }
  const fail = (cause: unknown) => {
    watcher?.close()
    watcher = undefined
    // Reported once per outage, not on every retry.
    if (!failing) onError(cause)
    failing = true
    clearTimeout(retry)
    retry = setTimeout(establish, WATCH_RETRY_MS)
  }
  const establish = () => {
    if (closed) return
    try {
      watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, filename) => {
        // `filename` can arrive empty; an unnamed event costs a redundant read, a dropped one costs the edit.
        if (!filename || filename.toString() === name) fire()
      })
      watcher.on("error", fail)
    } catch (cause) {
      return fail(cause)
    }
    // Edits made while no watch was running went unseen.
    if (failing) fire()
    failing = false
  }
  establish()
  return {
    close: () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(retry)
      watcher?.close()
    },
  }
}
