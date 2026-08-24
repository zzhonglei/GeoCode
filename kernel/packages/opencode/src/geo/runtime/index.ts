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

/* --- GeoCode: Runtime, the subprocess primitive of GeoKernel's infrastructure layer (docs/GEOKERNEL.md §3.2).
 *
 * The caller decides what counts as abnormal — how long silence or a whole run may last, how output is delivered —
 * and Runtime decides how to end correctly. It does not own WHEN an execution ends, so that control is an interface
 * rather than one blocking call: `start` hands back a live handle, and `run` is the wrapper over it. --- */

/** Bounds the drain on every path, kill or clean exit alike: a grandchild can hold the streams open forever. */
const SETTLEMENT = Duration.seconds(5)

/** Default window between asking a process to stop and forcing it. */
const DEFAULT_GRACE = Duration.seconds(3)

/** Bound on whatever Runtime holds on to, overridable only in collect mode. */
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

/** Chunks buffered between the reader and a slow consumer. See the queue comment in `start`. */
const CHUNK_BUFFER = 1024

/**
 * macOS only, where the check earns its keep: its crash reporter holds a dead child's stdio open, so without it the
 * call waits out the whole idle budget. Off elsewhere, per the platform switch in §3.2 异常终止识别.
 */
const LIVENESS_CHECK = process.platform === "darwin"

export type Reason =
  /** The process ended on its own. */
  | "exit"
  /** Stopped from outside — the caller's signal fired, or `terminate` was called. */
  | "abort"
  /** The total clock elapsed. */
  | "timeout"
  /** The idle clock elapsed — no output for longer than the caller allows. */
  | "idle"
  /** The process died while its output stream stayed open. */
  | "crash"
  /** The collect-mode cap was passed. Incremental mode gives the watchdog no limit, so it never ends this way. */
  | "output-limit"

/**
 * One of the two orthogonal axes (§3.2). Either way Runtime holds something — collect the result, incremental still
 * stderr for failure diagnosis — so both are bounded.
 */
export type Delivery =
  | {
      readonly mode: "collect"
      /** Overridable because some calls legitimately produce more (§3.2 参数面). */
      readonly limit?: number
    }
  | {
      readonly mode: "incremental"
      readonly onChunk: (chunk: string) => Effect.Effect<void>
      /** Whether stderr is interleaved into onChunk or accumulated separately. */
      readonly source?: "stdout" | "all"
    }

/** The other axis; at least one is required, since waiting without bound is an omission rather than a choice. */
export type Clocks =
  | { readonly total: Duration.Input; readonly idle?: Duration.Input }
  | { readonly total?: Duration.Input; readonly idle: Duration.Input }

export interface Options {
  readonly command: string
  readonly args: readonly string[]
  readonly delivery: Delivery
  readonly clocks: Clocks
  readonly cwd?: string
  /** Overlaid on the host environment, never replacing it (§3.2, §4.3 principle 8). */
  readonly env?: Record<string, string>
  /** Piped to stdin and closed. */
  readonly input?: string
  /**
   * The owner's stop signal — `ctx.abort` at the tool layer — the only channel tools meet that both stops and
   * reports what it produced, since tool bodies run on a detached root fiber (`EffectBridge.promise` is
   * `Effect.runPromise`) that abandoning the promise cannot interrupt; geo tools must be wired the same way. A
   * kernel caller interrupted through its scope is cleaned up but cannot report, so it should trip a signal (§3.2).
   */
  readonly abort?: AbortSignal
  /** Window before escalating to a forced kill. Overridable for tasks that clean up on exit. */
  readonly grace?: Duration.Input
  /** Shown in `list`, so an operator can tell one running execution from another. */
  readonly label?: string
}

export interface Result {
  /** Null when the process was killed before reporting one. */
  readonly code: number | null
  readonly reason: Reason
  /** Accumulated stdout in collect mode; empty in incremental mode. */
  readonly stdout: string
  /** Accumulated stderr, except in incremental mode with source "all". */
  readonly stderr: string
  readonly durationMs: number
  /** Output passed its cap and was cut. */
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

/** A running execution, for whoever owns its lifecycle: stopping, inspecting and awaiting it are separate acts. */
export interface Handle extends Live {
  /** Idempotent, and safe once the execution has already ended. Settles as `abort`. */
  readonly terminate: () => Effect.Effect<void>
  /** Readable while the execution runs. Stdout is empty in incremental mode, which streams rather than keeps it. */
  readonly partial: () => Effect.Effect<{ readonly stdout: string; readonly stderr: string }>
  /** Completes when the execution settles. Awaitable more than once. */
  readonly result: Effect.Effect<Result, Error>
}

export interface Interface {
  /** Start an execution and wait for it. Equivalent to `start` plus awaiting the result. */
  readonly run: (options: Options) => Effect.Effect<Result, Error>
  /** Start an execution and get its handle. Ends with the enclosing scope. */
  readonly start: (options: Options) => Effect.Effect<Handle, Error, Scope.Scope>
  readonly list: () => Effect.Effect<readonly Live[]>
  readonly terminateAll: () => Effect.Effect<void>
  /** For the host's shutdown path, where the choice is an immediate kill or processes left behind. */
  readonly killAllSync: () => void
}

/**
 * Children are process-group leaders on POSIX (the spawner passes `detached`), which is what lets one signal reach
 * the whole tree — and why they outlive us unsignalled. Windows has no process groups, hence `taskkill /T`, spawned
 * synchronously because the exit handler this runs under cannot await.
 */
function killTreeSync(pid: number) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      return
    }
    process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone, or not ours to signal — and nowhere useful to report it from, since we are on the way out.
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

    // Last line of defence, and the only process-wide hook here: `exit` observes a decision already made, including
    // the explicit `process.exit()` the CLI ends on, which skips every scope finalizer. Signals belong to the host
    // (§3.2) — a listener here would suppress Node's default termination and make this module decide how the whole
    // application shuts down.
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
            // Overlay, never replace: one missing base variable can stop the interpreter starting (§4.3 principle 8).
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
        // Total bytes ever seen: that is what the output limit judges, where the buffers below drop from the front.
        const accumulated = yield* Ref.make(0)
        const cap = limit ?? DEFAULT_OUTPUT_LIMIT
        const stdoutBuf = GeoOutput.boundedBuffer(cap)
        const stderrBuf = GeoOutput.boundedBuffer(cap)

        const interleaved = options.delivery.mode === "incremental" && options.delivery.source === "all"
        const primary = interleaved ? child.all : child.stdout

        // The idle clock refreshes when a chunk is READ off the process, never after the caller has handled it: the
        // consumer's own cost — writing to disk, updating a view — is not the task's to pay (§3.2).
        const touch = Effect.suspend(() => Ref.set(lastActivity, Date.now()))

        // That refresh point only means something if reading and consuming are genuinely decoupled: these streams are
        // pull-based, so a read-and-handle loop reads the next chunk only once the previous is handled and the gaps
        // stay the CONSUMER's wherever the refresh sits (§3.2 时钟语义).
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

        // External stop, an AbortController so it merges with the owner's own signal and repeat calls are harmless.
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

          // Draining runs on every path, normal exit included, or the last batch of output is lost just when the
          // caller most needs it. The settlement clock starts HERE rather than at the call, which would kill the
          // incremental task that legitimately runs for hours (§3.2).
          const drained = yield* Effect.timeoutOption(
            Effect.gen(function* () {
              // Reader first: it ends the queue, without which the consumer blocks on a chunk that never comes.
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

        live.set(id, handle)

        // Deregistration happens when the execution SETTLES, not when its scope closes: a scope can outlive many
        // executions, and `killAllSync` over a stale entry would signal a pid the system has since handed to
        // something else — process-group signals being indiscriminate. Registering first keeps the two in order
        // however fast the process exits.
        yield* Effect.forkScoped(
          Fiber.join(settleFiber).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => void live.delete(id)))),
        )

        // Scope closure is the other end, and tripping the stopper here is what sends an interrupted owner down the
        // SAME termination path as the other two channels rather than the spawner's own scope release (§3.2).
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
