export * as Preview from "./index.ts"

import path from "node:path"
import { Deferred, Effect, Exit, Option, Schema, Stream } from "effect"
import { Bundled } from "../bundled.ts"
import { Engine } from "../engine.ts"
import { Runtime } from "../runtime.ts"
import { Status } from "../status.ts"

const DOMAIN = "preview"

/** The domain of GeoCode's Python environment, whose base the readers run in. */
const ENVIRONMENT_DOMAIN = "python"

/**
 * As many readers as run at once, one for each dataset being looked at; a vector layer's reader holds its geometry in
 * memory. One more ends the reader asked the longest ago.
 */
const READERS = 4

/**
 * How long a reader stays when nothing is asked of it. A reader at work says so every few seconds, so a long answer,
 * as the first tile of a large vector layer is, does not run into it.
 */
const IDLE = "60 seconds"

/**
 * How long a request waits for GeoCode's Python environment to be ready: a tab the app opens again as it starts asks
 * before the environment is.
 */
const ENVIRONMENT_TIMEOUT = "100 seconds"

/** Characters kept of what a reader that ended printed, for the log. */
const OUTPUT_TAIL = 4 * 1024

/** How a reader is started with the base environment's interpreter. */
export type Launch = (python: string) => { readonly command: string; readonly args: readonly string[] }

const READER: Launch = (python) => Bundled.python(python, ["-m", "geocodekit.preview"])

const EnvironmentReady = Schema.Struct({ status: Schema.Literal("ready"), base: Schema.String })
const decodeEnvironmentReady = Schema.decodeUnknownExit(EnvironmentReady)

const Target = { path: Schema.String, layer: Schema.optionalKey(Schema.String) }
const DescribeParams = Schema.Struct(Target)
const TileParams = Schema.Struct({
  ...Target,
  stamp: Schema.String,
  z: Schema.Int,
  x: Schema.Int,
  y: Schema.Int,
})
const IdentifyParams = Schema.Struct({
  ...Target,
  stamp: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  tolerance: Schema.Number,
  /** Those of a layer's points, lines and polygons that are shown; all three when it is not given. */
  forms: Schema.optionalKey(Schema.Array(Schema.Literals(["points", "lines", "polygons"]))),
})

/** The line a reader's answer begins with. */
const Answer = Schema.Struct({
  id: Schema.Int,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  cancelled: Schema.optionalKey(Schema.Boolean),
})
const decodeAnswer = Schema.decodeUnknownExit(Answer)

const TileResult = Schema.Struct({ empty: Schema.Boolean })
const decodeTileResult = Schema.decodeUnknownExit(TileResult)
const IdentifyResult = Schema.Struct({ found: Schema.Unknown })
const decodeIdentifyResult = Schema.decodeUnknownExit(IdentifyResult)

type Settle = (outcome: Exit.Exit<{ readonly result: unknown; readonly bytes: Uint8Array }, Engine.Failure>) => void

interface Reader {
  readonly worker: Runtime.Worker
  /** The requests it has yet to answer, by their numbers. */
  readonly waiting: Map<number, Settle>
  /** When it was last asked, as a count of all the requests made. */
  asked: number
}

const cancellation = () => new Engine.Failure({ code: "cancelled", message: "the request was cancelled" })

/**
 * What the interface shows of a geographic dataset: its description, the tiles of its map and the feature under a
 * click, each read from the file by a reader that stays for the next request. `launch` starts a reader.
 */
export const capability = (launch: Launch = READER): Engine.Capability =>
  Effect.gen(function* () {
    const status = yield* Status.Service
    const runtime = yield* Runtime.Service
    const scope = yield* Effect.scope
    const environment = yield* Deferred.make<string>()
    const readers = new Map<string, Reader>()
    let asked = 0
    let numbered = 0

    yield* Effect.forkScoped(
      status.watch(ENVIRONMENT_DOMAIN).pipe(
        Stream.map((value) => decodeEnvironmentReady(value)),
        Stream.filter(Exit.isSuccess),
        Stream.runHead,
        Effect.flatMap((found) =>
          Option.isSome(found) ? Deferred.succeed(environment, found.value.value.base) : Effect.void,
        ),
      ),
    )

    const base = Deferred.await(environment).pipe(
      Effect.timeoutOption(ENVIRONMENT_TIMEOUT),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.fail(
              new Engine.Failure({ code: "not-ready", message: "GeoCode's Python environment is not ready" }),
            ),
      ),
    )

    /** The reader of a dataset, or of one layer of it, started when there is none. */
    const reader = (python: string, target: { readonly path: string; readonly layer?: string }) =>
      Effect.gen(function* () {
        const key = JSON.stringify([target.path, target.layer ?? null])
        const running = readers.get(key)
        if (running) return running
        if (readers.size >= READERS) {
          const oldest = [...readers].sort((a, b) => a[1].asked - b[1].asked)[0]
          // Out of the way at once: until it has ended it would count against the readers after this one too.
          readers.delete(oldest[0])
          oldest[1].worker.stop()
        }
        const waiting = new Map<number, Settle>()
        const worker = yield* runtime
          .worker({
            ...launch(python),
            idle: IDLE,
            onFrame: (header, bytes) => {
              const answer = decodeAnswer(header)
              // Thrown, it ends the reader: what it writes can no longer be matched to what was asked.
              if (Exit.isFailure(answer)) throw new Error(`a reader's answer was not understood: ${answer.cause}`)
              const settle = waiting.get(answer.value.id)
              if (!settle) return
              waiting.delete(answer.value.id)
              if (answer.value.cancelled) return settle(Exit.fail(cancellation()))
              if (answer.value.error) return settle(Exit.fail(new Engine.Failure(answer.value.error)))
              settle(Exit.succeed({ result: answer.value.result, bytes }))
            },
          })
          .pipe(Effect.mapError((error) => new Engine.Failure({ code: "shutting-down", message: error.message })))
        const started: Reader = { worker, waiting, asked }
        readers.set(key, started)
        worker.send(JSON.stringify({ path: target.path, layer: target.layer }))
        yield* Effect.forkIn(
          worker.ended.pipe(
            Effect.exit,
            Effect.flatMap((ended) =>
              Effect.gen(function* () {
                // Its place may already be another's: one stopped to make room, or for a reader of the same dataset.
                if (readers.get(key) === started) readers.delete(key)
                const how = Exit.isSuccess(ended) ? ended.value.reason : "failure"
                const unanswered = [...waiting.values()]
                waiting.clear()
                for (const settle of unanswered) {
                  settle(Exit.fail(new Engine.Failure({ code: "reader-ended", message: `the reader ended: ${how}` })))
                }
                // Stopped to make room or left unused, it ends as meant; anything else is worth a line in the log.
                if (unanswered.length === 0 && (how === "abort" || how === "idle")) return
                yield* Effect.logWarning("a preview's reader ended", {
                  path: target.path,
                  how,
                  unanswered: unanswered.length,
                  ...(Exit.isSuccess(ended)
                    ? {
                        code: ended.value.code,
                        signal: ended.value.signal,
                        output: ended.value.stderr.slice(-OUTPUT_TAIL),
                      }
                    : { error: String(ended.cause) }),
                })
              }),
            ),
          ),
          scope,
        )
        return started
      })

    /** A request to the dataset's reader and its answer; cancelled, it tells the reader and waits no longer. */
    const once = (target: { readonly path: string; readonly layer?: string }, request: object, signal: AbortSignal) =>
      Effect.gen(function* () {
        if (!path.isAbsolute(target.path)) {
          return yield* new Engine.Failure({ code: "invalid-params", message: `${target.path} is not absolute` })
        }
        const serving = yield* reader(yield* base, target)
        asked += 1
        serving.asked = asked
        numbered += 1
        const id = numbered
        return yield* Effect.callback<{ readonly result: unknown; readonly bytes: Uint8Array }, Engine.Failure>(
          (resume) => {
            const abort = () => {
              if (!serving.waiting.delete(id)) return
              serving.worker.send(JSON.stringify({ cancel: id }))
              resume(Effect.fail(cancellation()))
            }
            if (signal.aborted) return resume(Effect.fail(cancellation()))
            serving.waiting.set(id, (outcome) => {
              signal.removeEventListener("abort", abort)
              resume(outcome)
            })
            serving.worker.send(JSON.stringify({ ...request, id }))
            signal.addEventListener("abort", abort, { once: true })
            return Effect.sync(() => {
              signal.removeEventListener("abort", abort)
              abort()
            })
          },
        )
      })

    /**
     * Asked once more of a new reader when the first ended before it answered: a reader left unused ends at any
     * moment, the one a request is on its way to as well.
     */
    const ask = (target: { readonly path: string; readonly layer?: string }, request: object, signal: AbortSignal) =>
      once(target, request, signal).pipe(
        Effect.catchIf(
          (failure) => failure.code === "reader-ended",
          () => once(target, request, signal),
        ),
      )

    const invalid = (cause: unknown) => new Engine.Failure({ code: "invalid-params", message: String(cause) })
    const unexpected = (cause: unknown) =>
      new Engine.Failure({ code: "failed", message: `a reader's answer was not understood: ${cause}` })

    const describe: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(DescribeParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        return (yield* ask(params.value, { do: "describe" }, context.signal)).result
      })

    const tile: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(TileParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        const tile = { stamp: params.value.stamp, z: params.value.z, x: params.value.x, y: params.value.y }
        const answer = yield* ask(params.value, { do: "tile", ...tile }, context.signal)
        const result = decodeTileResult(answer.result)
        if (Exit.isFailure(result)) return yield* unexpected(result.cause)
        return result.value.empty ? { empty: true } : { bytes: answer.bytes }
      })

    const identify: Engine.Method = (raw, context) =>
      Effect.gen(function* () {
        const params = Schema.decodeUnknownExit(IdentifyParams)(raw)
        if (Exit.isFailure(params)) return yield* invalid(params.cause)
        const click = {
          stamp: params.value.stamp,
          x: params.value.x,
          y: params.value.y,
          tolerance: params.value.tolerance,
          forms: params.value.forms,
        }
        const answer = yield* ask(params.value, { do: "identify", ...click }, context.signal)
        const result = decodeIdentifyResult(answer.result)
        if (Exit.isFailure(result)) return yield* unexpected(result.cause)
        return result.value
      })

    return { domain: DOMAIN, methods: { describe, tile, identify } }
  })
