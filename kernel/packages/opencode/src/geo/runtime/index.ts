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

/* --- GeoCode: the Runtime module of GeoKernel's infrastructure layer
 * (docs/GEOKERNEL.md §3.2). Every subprocess GeoKernel starts goes through here.
 *
 * The division of labour is the point of the module: the CALLER decides what
 * counts as abnormal (how long silence is too long, how long is too long in
 * total, how output is delivered) and RUNTIME decides how to end correctly
 * (when the idle clock refreshes, that output is always drained, how killing
 * escalates, that the call returns at all).
 *
 * The four things Runtime fixes look like policy but are correctness invariants:
 * there is no second reasonable choice for any of them, so turning them into
 * options would only let each caller place a bet, and some of those bets would
 * be wrong.
 *
 * Runtime EXECUTES; it does not own when an execution should end. Deciding that
 * belongs to whoever started it — a tool call the user cancelled, a session
 * being torn down, the application shutting down — so every control those
 * owners need is exposed rather than hidden behind a single blocking call:
 * `start` hands back a live handle, `list` enumerates what is running, and
 * `terminateAll` ends everything. `run` is the convenience wrapper over `start`
 * for callers that just want the result. --- */

/** How long to wait for a killed process to release its output streams. */
const SETTLEMENT = Duration.seconds(5)

/** Default window between asking a process to stop and forcing it. */
const DEFAULT_GRACE = Duration.seconds(3)

/** Default bound on whatever Runtime holds on to. */
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

/** Chunks buffered between the reader and a slow consumer. See the queue comment in `start`. */
const CHUNK_BUFFER = 1024

/**
 * Whether the liveness check is trustworthy on this platform.
 *
 * On Windows a normally exiting process can briefly report as not running,
 * which would turn a long task that just finished successfully into a reported
 * crash. macOS is where the check earns its keep: its crash reporter holds the
 * child's stdio open while collecting a report, so without this the call would
 * wait out the entire idle budget after the process was already gone.
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
  /** Collected output passed its cap. */
  | "output-limit"

/**
 * Output delivery. One of the two orthogonal axes describing an execution
 * (§3.2): collect accumulates the output and hands it back at the end;
 * incremental passes each chunk on as it arrives and keeps no stdout of its own.
 *
 * Either way Runtime holds SOMETHING — collect holds the result, incremental
 * still holds stderr for failure diagnosis — so both are bounded.
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

/**
 * Clocks. The other axis. At least one is required — supplying neither means
 * waiting without bound, which is an omission rather than a choice, so the type
 * refuses it outright rather than letting the call hang (§3.2).
 */
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
   * Stop signal supplied by the owner of this execution. At the tool layer this
   * is `ctx.abort`.
   *
   * This is the channel that both stops the work AND reports what it produced.
   * The host makes it the only one that tools ever meet: tool bodies run through
   * `EffectBridge.promise`, i.e. `Effect.runPromise`, on a detached root fiber,
   * so abandoning the promise cannot interrupt them and cancellation has exactly
   * one way in (see `session/tools.ts`). Geo tools must be wired the same way.
   *
   * Interruption remains possible for callers INSIDE the kernel — a probe forked
   * into a scope that later closes. That path cleans up fully, but it cannot
   * report: whoever was awaiting the result is the very thing being torn down.
   * A caller that needs both should hand in a signal and trip it on interrupt,
   * the way the host does elsewhere:
   * `Effect.onInterrupt(() => Effect.sync(() => controller.abort()))`.
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
  /**
   * The output streams did not close within the settlement window, so what is
   * returned may be incomplete.
   *
   * Deliberately NOT a reason of its own: the reason is still whatever ended
   * the process. This is an additional fact about the output (§3.2).
   */
  readonly drainIncomplete: boolean
}

/** What `list` reports about a running execution. */
export interface Live {
  readonly id: string
  readonly label?: string
  readonly command: string
  readonly args: readonly string[]
  readonly pid: number | undefined
  readonly startedAt: number
}

/**
 * A running execution, for whoever owns its lifecycle.
 *
 * Handed out by `start` so that stopping, inspecting and awaiting an execution
 * are separate acts. A single blocking call can only offer the first of those,
 * and only to a caller willing to arrange a signal up front.
 */
export interface Handle extends Live {
  /**
   * Ask this execution to stop. Idempotent, and safe to call after it has
   * already ended. Settles as `abort`.
   */
  readonly terminate: () => Effect.Effect<void>
  /**
   * Output gathered so far, readable while the execution is still running.
   *
   * Empty in incremental mode for stdout, which is streamed rather than kept.
   */
  readonly partial: () => Effect.Effect<{ readonly stdout: string; readonly stderr: string }>
  /** Completes when the execution settles. Awaitable more than once. */
  readonly result: Effect.Effect<Result, Error>
}

export interface Interface {
  /** Start an execution and wait for it. Equivalent to `start` plus awaiting the result. */
  readonly run: (options: Options) => Effect.Effect<Result, Error>
  /** Start an execution and get its handle. Ends with the enclosing scope. */
  readonly start: (options: Options) => Effect.Effect<Handle, Error, Scope.Scope>
  /** Every execution currently running. */
  readonly list: () => Effect.Effect<readonly Live[]>
  /** Stop everything. For session teardown and application shutdown. */
  readonly terminateAll: () => Effect.Effect<void>
  /**
   * Kill every running process tree RIGHT NOW, synchronously.
   *
   * For the host's shutdown path, where nothing asynchronous can be relied on
   * to finish. Skips the whole graceful sequence on purpose: at that point the
   * choice is between an immediate kill and leaving processes behind.
   */
  readonly killAllSync: () => void
}

/**
 * Kill one process tree without awaiting anything.
 *
 * Spawned children are process-group leaders on POSIX (the spawner passes
 * `detached`), which is what lets a whole tree be signalled at once — and is
 * also precisely why they outlive us if nobody signals them. Windows has no
 * process groups to signal, so the tree is torn down through `taskkill /T`,
 * run synchronously because exit handlers cannot await.
 */
function killTreeSync(pid: number) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      return
    }
    process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone, or not ours to signal. Either way there is nothing to do
    // and nowhere useful to report it from — we are on the way out.
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

    /** Live executions, so an owner outside this module can find and stop them. */
    const live = new Map<string, Handle>()
    let counter = 0

    const killAllSync = () => {
      for (const handle of live.values()) if (handle.pid !== undefined) killTreeSync(handle.pid)
    }

    // Last line of defence, and deliberately the ONLY process-wide hook this
    // module installs. `exit` changes no behaviour — it observes a decision
    // already made, including the explicit `process.exit()` the CLI ends on,
    // which would otherwise skip every scope finalizer and strand whatever was
    // running.
    //
    // Signals are NOT handled here. Adding a SIGTERM or SIGINT listener would
    // suppress Node's default termination and make this module the arbiter of
    // how the whole application shuts down — which is not its call to make
    // (§3.2, "Runtime 只负责执行"). The host wires those to `killAllSync`.
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
            // Inherit and overlay rather than replace: a subprocess environment
            // has to be complete, and one missing base variable is enough to
            // stop the interpreter from starting (§3.2, §4.3 principle 8).
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
        // Total bytes ever seen. Separate from what the buffers hold, because
        // this is what the collect-mode cap judges: "did this task produce more
        // than its result is allowed to be", not "how much are we still holding".
        const accumulated = yield* Ref.make(0)
        const cap = limit ?? DEFAULT_OUTPUT_LIMIT
        const stdoutBuf = GeoOutput.boundedBuffer(cap)
        const stderrBuf = GeoOutput.boundedBuffer(cap)

        const interleaved = options.delivery.mode === "incremental" && options.delivery.source === "all"
        const primary = interleaved ? child.all : child.stdout

        // The idle clock refreshes HERE, when a chunk is read off the process,
        // never after the caller has finished handling it. Whether a task is
        // healthy depends on whether it produces output, not on how fast we
        // handle it, so the consumer's own cost — writing to disk, updating a
        // view — must not be charged against the task's idle budget (§3.2).
        const touch = Effect.suspend(() => Ref.set(lastActivity, Date.now()))

        // Reaching that property takes an actual decoupling, not just doing the
        // refresh before the callback. These streams are pull-based: with the
        // reader and the consumer in one loop, a chunk is only ever read when
        // the previous one has been handled, so the measured gaps are the
        // CONSUMER's pace no matter where inside the loop the refresh sits.
        // Reading into a queue lets the reader run at the process's pace.
        //
        // The queue is bounded, not unbounded — any accumulation needs a bound
        // (§3.2). The bound also sets the honest limit of the guarantee: while
        // the consumer stays within the buffer, idle measures true arrival; if
        // it falls far enough behind to fill it, backpressure takes over and
        // the two paces converge again.
        const queue = options.delivery.mode === "incremental" ? yield* Queue.bounded<string, Cause.Done>(CHUNK_BUFFER) : undefined
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

        // stderr is accumulated even in incremental mode: failure diagnosis
        // needs it, and it is not part of what the caller is streaming.
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

        // External stop, merged with the owner's own signal. An AbortController
        // rather than a bespoke primitive so both paths reach the same place and
        // repeat calls are harmless.
        const stopper = new AbortController()

        // Liveness is asked of the OPERATING SYSTEM directly, never of the
        // spawner's handle. The handle's notion of "running" settles on the
        // stream-close event — and the scenario this check exists for is
        // precisely the one where that event is being withheld: the process is
        // dead while a crash reporter (or an inheriting grandchild) keeps its
        // stdio open. Wired to the handle, the detector can never fire in the
        // only situation it is for, and the run waits out its whole idle
        // budget to end under the wrong reason.
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
            // Ignored rather than failed: a kill that does not take must not stop
            // us from returning the output already gathered.
            yield* child.kill({ forceKillAfter: options.grace ?? DEFAULT_GRACE }).pipe(Effect.ignore)
          }

          // Draining happens on EVERY path, normal exit included — otherwise the
          // final batch of output is lost, and on the timeout and interrupt paths
          // that is exactly when the caller most needs to know how far it got.
          //
          // The settlement clock starts HERE rather than at the call, because a
          // healthy task under incremental delivery may legitimately run for
          // hours; timing from the call would kill it. What it bounds is the
          // wrap-up: a grandchild that inherited the output handle can hold it
          // open forever, and without this bound the call never returns (§3.2).
          const drained = yield* Effect.timeoutOption(
            Effect.gen(function* () {
              // Reader first: it ends the queue, which is what lets the consumer
              // finish rather than block waiting for a chunk that will never come.
              yield* Fiber.join(primaryFiber).pipe(Effect.catchCause(() => Effect.void))
              if (stderrFiber) yield* Fiber.join(stderrFiber).pipe(Effect.catchCause(() => Effect.void))
              if (consumerFiber) yield* Fiber.join(consumerFiber).pipe(Effect.catchCause(() => Effect.void))
            }),
            SETTLEMENT,
          )

          // The buffers are already bounded; this trims the remaining case of a
          // single chunk larger than the cap.
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

        // Deregistration happens when the execution SETTLES, not when its scope
        // closes. A scope can outlive many executions, and a finished entry left
        // in the registry is not merely untidy: `killAllSync` would signal a pid
        // that the operating system has since handed to something else, and
        // process-group signals are indiscriminate. Registering first and
        // watching second is what keeps the two in order however fast the
        // process exits.
        yield* Effect.forkScoped(
          Fiber.join(settleFiber).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => void live.delete(id))),
          ),
        )

        // Scope closure is the other end: it runs however the execution ends —
        // normally, stopped, or with its owner interrupted out from under it.
        //
        // Tripping the stopper here is what makes interruption converge on the
        // SAME termination path as the other two channels, instead of relying on
        // the spawner's own scope release to be the thing that kills the tree.
        // Both do the job; having one path rather than two is what keeps the
        // escalation and the tree cleanup identical across all three.
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
