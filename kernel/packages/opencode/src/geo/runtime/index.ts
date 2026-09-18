export * as GeoRuntime from "./index"

import { Cause, Context, Duration, Effect, Fiber, Layer, Queue, Ref, Scope, Stream } from "effect"
import { spawnSync } from "node:child_process"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { GeoClocks } from "./clocks"
import { GeoOutput } from "./output"

export { GeoOutput } from "./output"

/* --- GeoCode: Runtime, GeoKernel's subprocess primitive (docs/GEOKERNEL.md §3.2). --- */

/** Bounds the drain on every path, kill or clean exit alike: a grandchild can hold the streams open forever. */
const SETTLEMENT = Duration.seconds(5)

const DEFAULT_GRACE = Duration.seconds(3)

/** Also bounds the buffers in incremental mode, where the caller cannot override it. */
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

const CHUNK_BUFFER = 1024

/**
 * macOS only, where the check earns its keep: its crash reporter holds a dead child's stdio open, so without it the
 * call waits out the whole idle budget (docs/GEOKERNEL.md §3.2).
 */
const LIVENESS_CHECK = process.platform === "darwin"

export type Reason =
  | "exit"
  | "abort"
  /** The total clock elapsed. */
  | "timeout"
  | "idle"
  /** The process died while its output stream stayed open. */
  | "crash"
  /** Collect mode only: incremental delivery gives the watchdog no limit. */
  | "output-limit"

export type Delivery =
  | {
      readonly mode: "collect"
      readonly limit?: number
    }
  | {
      readonly mode: "incremental"
      readonly onChunk: (chunk: string) => Effect.Effect<void>
      /** Whether stderr is interleaved into onChunk or accumulated separately. */
      readonly source?: "stdout" | "all"
    }

/** At least one is required, since waiting without bound is an omission rather than a choice. */
export type Clocks =
  | { readonly total: Duration.Input; readonly idle?: Duration.Input }
  | { readonly total?: Duration.Input; readonly idle: Duration.Input }

export interface Options {
  readonly command: string
  readonly args: readonly string[]
  readonly delivery: Delivery
  readonly clocks: Clocks
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly input?: string
  /**
   * Tools must pass `ctx.abort`: their bodies run under `Effect.runPromise`, so a cancelled call interrupts nothing
   * and this signal is the only stop that still returns what the run produced.
   */
  readonly abort?: AbortSignal
  readonly grace?: Duration.Input
  readonly label?: string
}

export interface Result {
  readonly code: number | null
  readonly reason: Reason
  /** Empty in incremental mode. */
  readonly stdout: string
  /** Accumulated stderr, except in incremental mode with source "all". */
  readonly stderr: string
  readonly durationMs: number
  readonly truncated: boolean
  /** The streams did not close within the settlement window, so this may be incomplete — not a reason of its own. */
  readonly drainIncomplete: boolean
}

export interface Live {
  readonly id: string
  readonly label?: string
  readonly command: string
  readonly args: readonly string[]
  readonly pid: number | undefined
  readonly startedAt: number
}

export interface Handle extends Live {
  /** Idempotent, and safe once the execution has already ended. Settles as `abort`. */
  readonly terminate: () => Effect.Effect<void>
  readonly partial: () => Effect.Effect<{ readonly stdout: string; readonly stderr: string }>
  /** Awaitable more than once. */
  readonly result: Effect.Effect<Result, Error>
}

export interface Interface {
  readonly run: (options: Options) => Effect.Effect<Result, Error>
  /** The execution is stopped when the enclosing scope closes. */
  readonly start: (options: Options) => Effect.Effect<Handle, Error, Scope.Scope>
  readonly list: () => Effect.Effect<readonly Live[]>
  readonly terminateAll: () => Effect.Effect<void>
  readonly killAllSync: () => void
}

/**
 * Signals the process group, which the spawner makes each child lead on POSIX; synchronous because it runs under the
 * `exit` handler, which cannot await.
 */
function killTreeSync(pid: number) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      return
    }
    process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone, or not ours to signal.
  }
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoRuntime") {}

export const use = serviceUse(Service)

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** Resolves when the signal fires; never otherwise. */
function aborted(signal: AbortSignal | undefined): Effect.Effect<void> {
  if (!signal) return Effect.never
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const handler = () => resume(Effect.void)
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const live = new Map<string, Handle>()
    let counter = 0

    const killAllSync = () => {
      for (const handle of live.values()) if (handle.pid !== undefined) killTreeSync(handle.pid)
    }

    // `exit` also covers the CLI's explicit process.exit(), which skips scope finalizers. No signal listeners here:
    // one would suppress Node's default termination, and signals belong to the host (docs/GEOKERNEL.md §3.2).
    process.on("exit", killAllSync)
    yield* Effect.addFinalizer(() => Effect.sync(() => void process.off("exit", killAllSync)))

    const start = (options: Options): Effect.Effect<Handle, Error, Scope.Scope> =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const id = `geoexec-${++counter}`
        const totalMs = options.clocks.total === undefined ? undefined : Duration.toMillis(options.clocks.total)
        const idleMs = options.clocks.idle === undefined ? undefined : Duration.toMillis(options.clocks.idle)
        const limit = options.delivery.mode === "collect" ? (options.delivery.limit ?? DEFAULT_OUTPUT_LIMIT) : undefined

        const child = yield* spawner.spawn(
          ChildProcess.make(options.command, [...options.args], {
            cwd: options.cwd,
            env: options.env,
            // Overlay, never replace: one missing base variable can stop the interpreter starting.
            extendEnv: true,
            stdin:
              options.input !== undefined
                ? Stream.fromIterable([new TextEncoder().encode(options.input)])
                : ("ignore" as const),
            killSignal: "SIGTERM",
            forceKillAfter: options.grace ?? DEFAULT_GRACE,
          }),
        )

        const lastActivity = yield* Ref.make(startedAt)
        // The output limit judges this total, not the buffers, which drop from the front to stay within the cap.
        const accumulated = yield* Ref.make(0)
        const cap = limit ?? DEFAULT_OUTPUT_LIMIT
        const stdoutBuf = GeoOutput.boundedBuffer(cap)
        const stderrBuf = GeoOutput.boundedBuffer(cap)

        const interleaved = options.delivery.mode === "incremental" && options.delivery.source === "all"
        const primary = interleaved ? child.all : child.stdout

        // Refreshed on read, never after the consumer handles a chunk, so a slow consumer spends no idle budget.
        const touch = Effect.suspend(() => Ref.set(lastActivity, Date.now()))

        // A queue, because these streams are pull-based: calling onChunk inside the read loop would bill the
        // consumer's time to the idle clock anyway.
        const queue =
          options.delivery.mode === "incremental" ? yield* Queue.bounded<string, Cause.Done>(CHUNK_BUFFER) : undefined
        const onChunk = options.delivery.mode === "incremental" ? options.delivery.onChunk : undefined

        const primaryFiber = yield* Effect.forkScoped(
          Stream.runForEach(Stream.decodeText(primary), (chunk) =>
            Effect.gen(function* () {
              yield* touch
              if (queue) {
                yield* Queue.offer(queue, chunk)
                return
              }
              stdoutBuf.push(chunk)
              yield* Ref.update(accumulated, (size) => size + chunk.length)
            }),
          ).pipe(Effect.ensuring(queue ? Queue.end(queue) : Effect.void)),
        )

        // Accumulated even in incremental mode, unless source "all" already streams it: diagnosis needs stderr.
        const stderrFiber = interleaved
          ? undefined
          : yield* Effect.forkScoped(
              Stream.runForEach(Stream.decodeText(child.stderr), (chunk) =>
                Effect.gen(function* () {
                  yield* touch
                  stderrBuf.push(chunk)
                  yield* Ref.update(accumulated, (size) => size + chunk.length)
                }),
              ),
            )

        const consumerFiber =
          queue && onChunk ? yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(queue), onChunk)) : undefined

        const stopper = new AbortController()

        // Liveness is asked of the operating system, never of the spawner's handle: the handle's "running" settles on
        // the stream-close event, the very thing a crash reporter or an inheriting grandchild is withholding.
        const pid = child.pid === undefined ? undefined : Number(child.pid)
        const osLiveness =
          LIVENESS_CHECK && pid !== undefined
            ? Effect.sync(() => {
                try {
                  process.kill(pid, 0)
                  return true
                } catch {
                  return false
                }
              })
            : undefined

        const watchdog = GeoClocks.watch({
          lastActivity,
          accumulated,
          startedAt,
          totalMs,
          idleMs,
          outputLimit: limit,
          isRunning: osLiveness,
          now: () => Date.now(),
        })

        const settle = Effect.gen(function* () {
          const winner = yield* Effect.raceAll([
            child.exitCode.pipe(Effect.map((code) => ({ reason: "exit" as Reason, code: code as number | null }))),
            aborted(options.abort).pipe(Effect.map(() => ({ reason: "abort" as Reason, code: null }))),
            aborted(stopper.signal).pipe(Effect.map(() => ({ reason: "abort" as Reason, code: null }))),
            watchdog.pipe(Effect.map((verdict) => ({ reason: verdict as Reason, code: null }))),
          ])

          if (winner.reason !== "exit") {
            // Ignored rather than failed: a kill that does not take must not cost the output already gathered.
            yield* child.kill({ forceKillAfter: options.grace ?? DEFAULT_GRACE }).pipe(Effect.ignore)
          }

          // Drained on every path, clean exit included; the settlement clock starts here, not at the call, or it would
          // cut runs that legitimately last for hours.
          const drained = yield* Effect.timeoutOption(
            Effect.gen(function* () {
              yield* Fiber.join(primaryFiber).pipe(Effect.catchCause(() => Effect.void))
              if (stderrFiber) yield* Fiber.join(stderrFiber).pipe(Effect.catchCause(() => Effect.void))
              if (consumerFiber) yield* Fiber.join(consumerFiber).pipe(Effect.catchCause(() => Effect.void))
            }),
            SETTLEMENT,
          )

          // The buffers are already bounded; this trims the remaining case of a single chunk larger than the cap.
          const stdout = GeoOutput.truncate(stdoutBuf.text(), cap)
          const stderr = GeoOutput.truncate(stderrBuf.text(), cap)

          return {
            code: winner.code,
            reason: winner.reason,
            stdout: stdout.text,
            stderr: stderr.text,
            durationMs: Date.now() - startedAt,
            truncated: stdout.truncated || stderr.truncated || stdoutBuf.dropped() || stderrBuf.dropped(),
            drainIncomplete: drained._tag === "None",
          } satisfies Result
        })

        const settleFiber = yield* Effect.forkScoped(settle)

        const handle: Handle = {
          id,
          label: options.label,
          command: options.command,
          args: options.args,
          pid: child.pid === undefined ? undefined : Number(child.pid),
          startedAt,
          terminate: () => Effect.sync(() => stopper.abort()),
          partial: () => Effect.sync(() => ({ stdout: stdoutBuf.text(), stderr: stderrBuf.text() })),
          result: Fiber.join(settleFiber).pipe(Effect.mapError(toError)),
        }

        // Registered before the fork below, or an execution that settles first is deleted before it is added.
        live.set(id, handle)

        // Deregistered on settling, not only at scope close: a scope can outlive its executions, and `killAllSync` over
        // a stale entry would signal a pid the system has since reused.
        yield* Effect.forkScoped(
          Fiber.join(settleFiber).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => void live.delete(id)))),
        )

        // Tripping the stopper sends an interrupted owner down the same termination path as the other stops, not the
        // spawner's own scope release.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stopper.abort()
            live.delete(id)
          }),
        )

        return handle
      }).pipe(Effect.mapError(toError))

    const run = (options: Options): Effect.Effect<Result, Error> =>
      Effect.scoped(start(options).pipe(Effect.flatMap((handle) => handle.result)))

    const list = () =>
      Effect.sync((): readonly Live[] =>
        Array.from(live.values(), ({ id, label, command, args, pid, startedAt }) => ({
          id,
          label,
          command,
          args,
          pid,
          startedAt,
        })),
      )

    const terminateAll = () =>
      Effect.forEach(Array.from(live.values()), (handle) => handle.terminate(), { discard: true })

    return Service.of({ run, start, list, terminateAll, killAllSync })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [CrossSpawnSpawner.node] })
