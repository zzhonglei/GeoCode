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

/**
 * The most one answer of a worker may hold, its line or its bytes: an answer gone wrong must not fill the engine's
 * memory.
 */
const FRAME_LIMIT = 64 * 1024 * 1024

/** The precision of the clocks, not a property of the task. */
const POLL_MS = 100

/**
 * A poll this much later than due was a sleep; a stall of the engine's own that long is forgiven as well. The kernel's
 * qgisrun judges its own clock the same way.
 */
const SLEEP_MS = 5000

const POSIX = process.platform !== "win32"

/**
 * What a task keeps of the engine's environment, by name in any case. Tasks run GeoCode's Python, a QGIS it found or a
 * system program, which what the user set for their own tools (PATH, PYTHONPATH, GDAL_*, PROJ_*, conda's) would only
 * point elsewhere: so only the network, the account and its temporary directory, and what the system itself needs.
 */
const KEPT = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  // Windows' own, set for every program; QGIS's launcher and Python read some of them.
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "PSMODULEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
])

/** The system's own directories in place of the user's PATH, for the system tools a launcher or a library calls. */
function systemPath(engine: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32") return "/usr/bin:/bin:/usr/sbin:/sbin"
  const root = Object.entries(engine).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows"
  return [`${root}\\System32`, root].join(";")
}

/** The environment every task starts from, before its own variables. */
export function base(engine: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const result: Record<string, string> = { PATH: systemPath(engine, platform) }
  for (const [name, value] of Object.entries(engine))
    if (value !== undefined && KEPT.has(name.toUpperCase())) result[name] = value
  return result
}

export type Reason = "exit" | "abort" | "timeout" | "idle" | "output-limit"

export type Delivery =
  | { readonly mode: "collect"; readonly limit?: number }
  | {
      readonly mode: "incremental"
      /**
       * The idle clock is refreshed before it runs, so its own time is never billed. If it throws, the run is ended
       * and fails with that error.
       */
      readonly onChunk: (chunk: string, stream: "stdout" | "stderr") => void
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
  /** Laid over what a task keeps of the engine's environment (`base`). */
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

/**
 * A process that stays to answer requests, each a line written to it. Its idle clock counts the time in which it was
 * neither asked nor wrote anything: it ends a worker no one uses, and one that hangs once no one asks it any more.
 * So it must be longer than the longest a request may take in silence.
 */
export type WorkerOptions = Pick<Options, "command" | "args" | "cwd" | "env" | "grace"> & {
  readonly idle: Duration.Input
  /**
   * Each answer is a line of JSON and, after it, as many bytes as the number under its `bytes` says. The bytes are the
   * consumer's own copy, empty when the line names none. If it throws, the worker is ended and fails with that error,
   * as it does on an answer that is not one.
   */
  readonly onFrame: (header: unknown, bytes: Uint8Array) => void
}

export interface Worker {
  /** Writes a line to the process. Dropped once the process has exited: whoever waits on it learns from `ended`. */
  readonly send: (line: string) => void
  readonly stop: () => void
  /** Settles when the process is gone, however it went; `stdout` is empty. */
  readonly ended: Effect.Effect<Result, Error>
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
  /** Shutdown ends a worker as it ends a run. */
  readonly worker: (options: WorkerOptions) => Effect.Effect<Worker, ShuttingDown>
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

      const worker = (options: WorkerOptions) =>
        Effect.suspend(() => {
          if (closing) return Effect.fail(new ShuttingDown({ message: "GeoEngine is shutting down" }))
          const execution = execute(options, ledger)
          live.add(execution)
          // Settled here, so a worker no one waits on does not end the engine with an unhandled rejection.
          const settled = execution.result.then(
            (result) => {
              live.delete(execution)
              return Effect.succeed(result)
            },
            (error: unknown) => {
              live.delete(execution)
              return Effect.fail(error instanceof Error ? error : new Error(String(error)))
            },
          )
          return Effect.succeed<Worker>({
            send: execution.write,
            stop: () => execution.stop("abort"),
            ended: Effect.flatten(Effect.promise(() => settled)),
          })
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
      return Service.of({ run, worker, shutdown })
    }),
  )

interface Execution {
  readonly result: Promise<Result>
  readonly stop: (reason: Reason, graceMs?: number) => void
  /** A worker's only. */
  readonly write: (line: string) => void
}

function execute(options: Options | WorkerOptions, ledger: Ledger): Execution {
  const task = "delivery" in options ? options : undefined
  const worker = "onFrame" in options ? options : undefined
  if (task?.signal?.aborted) return { result: Promise.resolve(aborted()), stop: () => {}, write: () => {} }

  const now = () => performance.now()
  const startedAt = now()
  const grace = Duration.toMillis(options.grace ?? DEFAULT_GRACE)
  const totalMs = task?.clocks.total === undefined ? undefined : Duration.toMillis(task.clocks.total)
  const idle = worker ? worker.idle : task?.clocks.idle
  const idleMs = idle === undefined ? undefined : Duration.toMillis(idle)
  const limit = task?.delivery.mode === "collect" ? (task.delivery.limit ?? DEFAULT_OUTPUT_LIMIT) : undefined
  const cap = limit ?? DEFAULT_OUTPUT_LIMIT
  const stdout = boundedBuffer(cap)
  const stderr = boundedBuffer(cap)
  const incremental = task?.delivery.mode === "incremental" ? task.delivery : undefined
  const interleaved = incremental?.source === "all"

  let lastActivity = startedAt
  // Time the computer spent asleep, which neither clock counts.
  let slept = 0
  let accumulated = 0
  let reason: Reason | undefined
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  // What a consumer threw, or what was wrong with a worker's answer: the run is ended and fails with it.
  let failure: unknown
  let stop: (reason: Reason, graceMs?: number) => void = () => {}
  let write: (line: string) => void = () => {}
  // Defined before the spawn: a failed spawn settles, and removes this listener, before the rest of the setup runs.
  const onAbort = () => stop("abort")

  const result = new Promise<Result>((resolve, reject) => {
    const child = launch(options.command, [...options.args], {
      cwd: options.cwd,
      env: overlay(base(process.env, process.platform), options.env ?? {}, process.platform),
      stdio: [task?.input === undefined && !worker ? "ignore" : "pipe", "pipe", "pipe"],
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
      task?.signal?.removeEventListener("abort", onAbort)
      release()
      return true
    }

    const finish = (drainIncomplete: boolean) => {
      if (!settle()) return
      if (failure !== undefined) return reject(failure)
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

    task?.signal?.addEventListener("abort", onAbort, { once: true })

    const deliver = (target: "stdout" | "stderr", chunk: string) => {
      if (!chunk) return
      if (incremental && (target === "stdout" || interleaved)) {
        if (failure !== undefined) return
        try {
          return incremental.onChunk(chunk, target)
        } catch (error) {
          failure = error
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

    // A worker's stdout, cut into answers. What has arrived of the answer still incomplete is kept in pieces, joined
    // once it is whole: a large answer comes in many pieces, and joining at each would copy it over and over.
    let pieces: Buffer[] = []
    let held = 0
    // The line of the answer whose bytes are still arriving.
    let awaited: { readonly header: unknown; readonly bytes: number } | undefined
    const frames = (data: Buffer) => {
      lastActivity = now()
      if (!worker || failure !== undefined || reason !== undefined) return
      pieces.push(data)
      held += data.length
      // Nothing left over held a line's end, so only the new piece can.
      if (awaited ? held < awaited.bytes : !data.includes(0x0a)) {
        // Only a line can outgrow the limit here: an answer's bytes were refused when its line named them.
        if (held > FRAME_LIMIT) stop("output-limit")
        return
      }
      let rest = pieces.length === 1 ? data : Buffer.concat(pieces)
      try {
        for (;;) {
          if (awaited === undefined) {
            const end = rest.indexOf(0x0a)
            if (end < 0) break
            const line = rest.subarray(0, end).toString("utf8")
            rest = rest.subarray(end + 1)
            const header = frameHeader(line)
            if (header.bytes > FRAME_LIMIT) return stop("output-limit")
            awaited = header
          }
          if (rest.length < awaited.bytes) break
          // Copied out: the consumer may keep or send it on, and a view would hold the answers after it too.
          const bytes = new Uint8Array(rest.subarray(0, awaited.bytes))
          rest = rest.subarray(awaited.bytes)
          const header = awaited.header
          awaited = undefined
          worker.onFrame(header, bytes)
        }
      } catch (error) {
        failure = error
        return stop("abort")
      }
      pieces = rest.length > 0 ? [rest] : []
      held = rest.length
    }

    child.stdout?.on("data", worker ? frames : read("stdout"))
    child.stderr?.on("data", read("stderr"))
    // A task that exits without reading its input breaks the pipe; that is its business, not a crash of the engine.
    child.stdin?.on("error", () => {})
    if (task?.input !== undefined) child.stdin?.end(task.input)
    write = (line) => {
      if (exit !== undefined || settled) return
      lastActivity = now()
      child.stdin?.write(`${line}\n`)
    }

    // The monotonic clock stops while macOS sleeps but runs on while Windows does: a poll that comes far later than
    // due is taken for a sleep on either, so a laptop does not wake to find every running task idle.
    let polled = startedAt
    watchdog = setInterval(() => {
      const at = now()
      const late = at - polled - POLL_MS
      polled = at
      if (late > SLEEP_MS) {
        slept += late
        lastActivity = Math.min(at, lastActivity + late)
      }
      if (limit !== undefined && accumulated > limit) return stop("output-limit")
      // Idle before total: when both have elapsed, going silent is the more specific verdict.
      if (idleMs !== undefined && at - lastActivity >= idleMs) return stop("idle")
      if (totalMs !== undefined && at - startedAt - slept >= totalMs) stop("timeout")
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

  return { result, stop: (next, graceMs) => stop(next, graceMs), write: (line) => write(line) }
}

/** The line that opens a worker's answer, and how many bytes it says follow it. */
function frameHeader(line: string) {
  const header: unknown = (() => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`a worker's answer did not begin with a line of JSON: ${line.slice(0, 200)}`)
    }
  })()
  const bytes = (header as { readonly bytes?: unknown } | null)?.bytes ?? 0
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(`a worker's answer gave ${JSON.stringify(bytes)} as its number of bytes`)
  return { header, bytes }
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
