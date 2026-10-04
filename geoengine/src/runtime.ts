export * as Runtime from "./runtime.ts"

import path from "node:path"
import { performance } from "node:perf_hooks"
import { StringDecoder } from "node:string_decoder"
import launch from "cross-spawn"
import { Context, Data, Duration, Effect, Layer } from "effect"

/** Bounds the drain after the process is gone: a stray holder of the pipes must not keep the call from returning. */
const SETTLEMENT_MS = 5000

const DEFAULT_GRACE = Duration.seconds(3)

/** Caps every task's grace at shutdown: the main process waits for the sweep, and a task's own grace is unbounded. */
const SHUTDOWN_GRACE_MS = 2000

/** In characters. Also caps the stderr kept in incremental mode, which the caller cannot override. */
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

/** The precision of the clocks, not a property of the task. */
const POLL_MS = 100

const POSIX = process.platform !== "win32"

export type Reason = "exit" | "abort" | "timeout" | "idle" | "output-limit"

export type Delivery =
  | { readonly mode: "collect"; readonly limit?: number }
  | {
      readonly mode: "incremental"
      /**
       * The idle clock is refreshed before it runs, so its own time is never billed. If it throws, the run is ended
       * and fails with that error.
       */
      readonly onChunk: (chunk: string) => void
      /** Whether stderr is delivered through onChunk too, or only accumulated. */
      readonly source?: "stdout" | "all"
    }

/** At least one: waiting without any bound is an omission, not a choice. */
export type Clocks =
  | { readonly total: Duration.Input; readonly idle?: Duration.Input }
  | { readonly total?: Duration.Input; readonly idle: Duration.Input }

export interface Options {
  readonly command: string
  readonly args: readonly string[]
  readonly delivery: Delivery
  readonly clocks: Clocks
  readonly cwd?: string
  /** Laid over the engine's environment, never replacing it: one missing base variable can stop an interpreter. */
  readonly env?: Record<string, string>
  readonly input?: string
  /** A stop through this signal still returns what the run produced, settling as `abort`. */
  readonly signal?: AbortSignal
  readonly grace?: Duration.Input
}

export interface Result {
  readonly code: number | null
  /** Set when the process was ended by a signal, its own crash included. */
  readonly signal: NodeJS.Signals | null
  readonly reason: Reason
  /** Empty in incremental mode. */
  readonly stdout: string
  /** Accumulated stderr, except in incremental mode with source "all". */
  readonly stderr: string
  readonly durationMs: number
  readonly truncated: boolean
  /** The pipes stayed open past the settlement window, so the output may be incomplete. */
  readonly drainIncomplete: boolean
}

/** Every task process is reported, so the main process can end what a crashed engine leaves behind. */
export interface Ledger {
  readonly started: (pid: number) => void
  readonly ended: (pid: number) => void
}

/** A run refused because the engine is shutting down, told apart from a run that failed to start. */
export class ShuttingDown extends Data.TaggedError("GeoEngineShuttingDown")<{ readonly message: string }> {}

export interface Interface {
  readonly run: (options: Options) => Effect.Effect<Result, Error>
  /** Refuses every run from now on, ends the running ones and waits until none is left. */
  readonly shutdown: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/GeoEngine/Runtime") {}

export const layer = (ledger: Ledger) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const live = new Set<Execution>()
      let closing = false

      const run = (options: Options) =>
        Effect.callback<Result, Error>((resume) => {
          // Checked where the run is registered, so no run can start between shutdown's last look and this one.
          if (closing) return resume(Effect.fail(new ShuttingDown({ message: "GeoEngine is shutting down" })))
          const execution = execute(options, ledger)
          live.add(execution)
          execution.result.then(
            (result) => {
              live.delete(execution)
              resume(Effect.succeed(result))
            },
            (error: unknown) => {
              live.delete(execution)
              resume(Effect.fail(error instanceof Error ? error : new Error(String(error))))
            },
          )
          return Effect.sync(() => execution.stop("abort"))
        })

      const shutdown = () =>
        Effect.promise(async () => {
          closing = true
          while (live.size > 0) {
            await Promise.allSettled(
              Array.from(live, (execution) => {
                execution.stop("abort", SHUTDOWN_GRACE_MS)
                return execution.result
              }),
            )
          }
        })

      yield* Effect.addFinalizer(shutdown)
      return Service.of({ run, shutdown })
    }),
  )

interface Execution {
  readonly result: Promise<Result>
  readonly stop: (reason: Reason, graceMs?: number) => void
}

function execute(options: Options, ledger: Ledger): Execution {
  if (options.signal?.aborted) return { result: Promise.resolve(aborted()), stop: () => {} }

  const now = () => performance.now()
  const startedAt = now()
  const grace = Duration.toMillis(options.grace ?? DEFAULT_GRACE)
  const totalMs = options.clocks.total === undefined ? undefined : Duration.toMillis(options.clocks.total)
  const idleMs = options.clocks.idle === undefined ? undefined : Duration.toMillis(options.clocks.idle)
  const limit = options.delivery.mode === "collect" ? (options.delivery.limit ?? DEFAULT_OUTPUT_LIMIT) : undefined
  const cap = limit ?? DEFAULT_OUTPUT_LIMIT
  const stdout = boundedBuffer(cap)
  const stderr = boundedBuffer(cap)
  const incremental = options.delivery.mode === "incremental" ? options.delivery : undefined
  const interleaved = incremental?.source === "all"

  let lastActivity = startedAt
  let accumulated = 0
  let reason: Reason | undefined
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let consumerError: unknown
  let stop: (reason: Reason, graceMs?: number) => void = () => {}
  // Defined before the spawn: a failed spawn settles, and removes this listener, before the rest of the setup runs.
  const onAbort = () => stop("abort")

  const result = new Promise<Result>((resolve, reject) => {
    const child = launch(options.command, [...options.args], {
      cwd: options.cwd,
      env: overlay(process.env, options.env ?? {}, process.platform),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Its own process group on POSIX, so one signal reaches everything the task starts.
      detached: POSIX,
      windowsHide: true,
    })
    const pid = child.pid

    let watchdog: NodeJS.Timeout | undefined
    let forceKill: NodeJS.Timeout | undefined
    let forceKillAt = Infinity
    let settlement: NodeJS.Timeout | undefined
    let settled = false
    let released = false

    // Once the process has exited its pid may be reused, so the main process must stop holding it at once.
    const release = () => {
      if (released || pid === undefined) return
      released = true
      ledger.ended(pid)
    }

    const settle = () => {
      if (settled) return false
      settled = true
      clearInterval(watchdog)
      clearTimeout(forceKill)
      clearTimeout(settlement)
      options.signal?.removeEventListener("abort", onAbort)
      release()
      return true
    }

    const finish = (drainIncomplete: boolean) => {
      if (!settle()) return
      if (consumerError !== undefined) return reject(consumerError)
      const out = truncate(stdout.text(), cap)
      const err = truncate(stderr.text(), cap)
      resolve({
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        reason: reason ?? "exit",
        stdout: out.text,
        stderr: err.text,
        durationMs: Math.round(now() - startedAt),
        truncated: out.truncated || err.truncated || stdout.dropped() || stderr.dropped(),
        drainIncomplete,
      })
    }

    const startSettlement = () => {
      if (settlement === undefined) settlement = setTimeout(() => finish(true), SETTLEMENT_MS)
    }

    // A missing executable fails at once rather than waiting out a clock; on Windows cross-spawn reports it here
    // after the process has a pid.
    child.once("error", (error) => {
      if (settle()) reject(error)
    })
    if (pid === undefined) return
    ledger.started(pid)

    stop = (next, graceMs = grace) => {
      if (exit !== undefined || settled) return
      if (reason === undefined) {
        reason = next
        killTree(pid, "SIGTERM")
      }
      // A later stop may shorten the grace, as shutdown does, but never lengthen it.
      if (now() + graceMs >= forceKillAt) return
      forceKillAt = now() + graceMs
      clearTimeout(forceKill)
      forceKill = setTimeout(() => {
        killTree(pid, "SIGKILL")
        startSettlement()
      }, graceMs)
    }

    options.signal?.addEventListener("abort", onAbort, { once: true })

    const deliver = (target: "stdout" | "stderr", chunk: string) => {
      if (!chunk) return
      if (incremental && (target === "stdout" || interleaved)) {
        if (consumerError !== undefined) return
        try {
          return incremental.onChunk(chunk)
        } catch (error) {
          consumerError = error
          return stop("abort")
        }
      }
      accumulated += chunk.length
      const buffer = target === "stdout" ? stdout : stderr
      buffer.push(chunk)
    }
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    const read = (target: "stdout" | "stderr") => (data: Buffer) => {
      // Refreshed on arrival, before any consumer runs.
      lastActivity = now()
      deliver(target, decoders[target].write(data))
    }
    child.stdout?.on("data", read("stdout"))
    child.stderr?.on("data", read("stderr"))
    // A task that exits without reading its input breaks the pipe; that is its business, not a crash of the engine.
    child.stdin?.on("error", () => {})
    if (options.input !== undefined) child.stdin?.end(options.input)

    // A monotonic clock, so a sleeping laptop does not wake to find every running task idle.
    watchdog = setInterval(() => {
      if (limit !== undefined && accumulated > limit) return stop("output-limit")
      // Idle before total: when both have elapsed, going silent is the more specific verdict.
      if (idleMs !== undefined && now() - lastActivity >= idleMs) return stop("idle")
      if (totalMs !== undefined && now() - startedAt >= totalMs) stop("timeout")
    }, POLL_MS)

    child.once("exit", (code, signal) => {
      exit = { code, signal }
      clearTimeout(forceKill)
      // Whatever the task left running in its group goes with it. Not on Windows, where there is no group and the
      // exited pid may already belong to an unrelated process.
      if (POSIX) killTree(pid, "SIGKILL")
      release()
      startSettlement()
    })
    child.once("close", () => {
      deliver("stdout", decoders.stdout.end())
      deliver("stderr", decoders.stderr.end())
      finish(false)
    })
  })

  return { result, stop: (next, graceMs) => stop(next, graceMs) }
}

/**
 * The engine's environment with a task's variables laid over it. Windows treats names without regard to case and
 * Node keeps whatever case the system used (`Path`), so there an override replaces every spelling of its name rather
 * than adding a second one the process would pick between.
 */
export function overlay(base: NodeJS.ProcessEnv, extra: Record<string, string>, platform: NodeJS.Platform) {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined) result[name] = value
  for (const [name, value] of Object.entries(extra)) {
    if (platform === "win32") {
      for (const existing of Object.keys(result))
        if (existing.toUpperCase() === name.toUpperCase()) delete result[existing]
    }
    result[name] = value
  }
  return result
}

function aborted(): Result {
  return {
    code: null,
    signal: null,
    reason: "abort",
    stdout: "",
    stderr: "",
    durationMs: 0,
    truncated: false,
    drainIncomplete: false,
  }
}

/** Quiet when the tree is already gone. Windows has no signals, so both levels are a forced end. */
function killTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  if (!POSIX) {
    // By its full path, so neither a PATH without System32 nor another program of that name gets in the way.
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
    launch(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {})
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {}
}

/** Keeps the tail, where errors, tracebacks and result markers arrive, without splitting a surrogate pair. */
function truncate(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false }
  const start = text.length - limit
  const low = text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff
  return { text: text.slice(low ? start + 1 : start), truncated: true }
}

/** Bounded while it fills, since stderr is kept for a whole execution; one chunk larger than `cap` is kept whole. */
function boundedBuffer(cap: number) {
  const parts: string[] = []
  let size = 0
  let discarded = false
  return {
    push(chunk: string) {
      parts.push(chunk)
      size += chunk.length
      while (size > cap && parts.length > 1) {
        size -= parts.shift()!.length
        discarded = true
      }
    },
    text: () => parts.join(""),
    dropped: () => discarded,
  }
}
