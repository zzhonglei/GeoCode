export * as Engine from "./engine.ts"

import { Cause, Data, Effect, Exit, Result, Schema, type Scope, Stream } from "effect"
import { Config } from "./config.ts"
import { Protocol } from "./protocol.ts"
import { Runtime } from "./runtime.ts"
import { Status } from "./status.ts"
import type { Transport } from "./transport.ts"

export type Services = Runtime.Service | Status.Service | Config.Service

/** A method's expected failure, returned to the caller as it is; anything else is reported as `internal`. */
export class Failure extends Data.TaggedError("GeoEngineFailure")<Protocol.Failure> {}

export interface MethodContext {
  /** Fires on a cancel or at shutdown; pass it to `Runtime.run` so the run still returns what it produced. */
  readonly signal: AbortSignal
  readonly progress: (data: unknown) => void
}

/** Decodes its own params: they arrive as the main process sent them. */
export type Method = (params: unknown, context: MethodContext) => Effect.Effect<unknown, Failure, Services>

export interface Definition {
  readonly domain: string
  readonly methods: Readonly<Record<string, Method>>
}

/**
 * Runs once in the engine's scope before `ready`: it registers the domain's status and config block, forks its own
 * environment checks so a slow one holds up nothing, and returns methods that can close over what it set up.
 */
export type Capability = Effect.Effect<Definition, never, Services | Scope.Scope>

export const ledger = (transport: Transport): Runtime.Ledger => ({
  started: (pid) => transport.send({ type: "task", event: "start", pid }),
  ended: (pid) => transport.send({ type: "task", event: "end", pid }),
})

const decodeInbound = Schema.decodeUnknownExit(Protocol.Inbound)

/** How long shutdown waits for cancelled requests to answer once their tasks have ended; it bounds the main process's wait. */
const REQUEST_DRAIN = "2 seconds"

/** Runs until its scope closes, which ends every request and task still running. */
export const run = (transport: Transport, capabilities: readonly Capability[]) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Service
    const status = yield* Status.Service
    const scope = yield* Effect.scope
    const runFork = Effect.runForkWith(yield* Effect.context<Services>())
    // Forked into the engine's scope, so closing it interrupts them.
    const fork = (effect: Effect.Effect<unknown, unknown, Services>) => runFork(Effect.forkIn(effect, scope))
    const warn = (message: string, detail: unknown) => fork(Effect.logWarning(message, detail))

    // Subscribed before any capability registers, so every domain's first value reaches the main process.
    const changes = yield* status.changes
    yield* Effect.forkScoped(
      Stream.runForEach(changes, (change) =>
        // One value the channel cannot carry must not end forwarding for every domain after it.
        Effect.try(() => transport.send({ type: "status", domain: change.domain, value: change.value })).pipe(
          Effect.catch((error) => Effect.logWarning(`GeoEngine could not send the ${change.domain} status`, error)),
        ),
      ),
    )

    const methods = new Map<string, Method>()
    for (const capability of capabilities) {
      const defined = yield* Effect.exit(capability)
      if (Exit.isFailure(defined)) {
        warn("GeoEngine skipped a capability that failed to start", Cause.pretty(defined.cause))
        continue
      }
      for (const [name, method] of Object.entries(defined.value.methods)) {
        methods.set(`${defined.value.domain}.${name}`, method)
      }
    }

    const inflight = new Map<number, AbortController>()
    let closing = false

    const respond = (id: number, cancelled: boolean, exit: Exit.Exit<unknown, Failure>) => {
      const found = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined
      const failure = found && Result.isSuccess(found) ? found.success : undefined
      const response: Protocol.Response = Exit.isSuccess(exit)
        ? { type: "response", id, cancelled, ok: true, result: exit.value }
        : failure
          ? // A plain object: cloning the error instance itself would keep only its message.
            {
              type: "response",
              id,
              cancelled,
              ok: false,
              error: { code: failure.code, message: failure.message, details: failure.details },
            }
          : {
              type: "response",
              id,
              cancelled,
              ok: false,
              error: { code: "internal", message: Cause.pretty(exit.cause) },
            }
      try {
        transport.send(response)
      } catch (error) {
        // A result the channel cannot carry must still answer, or the caller waits for good.
        const message = `the response could not be sent: ${error instanceof Error ? error.message : String(error)}`
        transport.send({ type: "response", id, cancelled, ok: false, error: { code: "internal", message } })
      }
    }

    const refuse = (id: number, code: string, message: string) =>
      transport.send({ type: "response", id, cancelled: false, ok: false, error: { code, message } })

    const request = (message: typeof Protocol.Request.Type) => {
      // Answering would end the caller's wait for the request already running under this id.
      if (inflight.has(message.id)) return warn("GeoEngine ignored a request reusing a running id", message.id)
      if (closing) return refuse(message.id, "shutting-down", "GeoEngine is shutting down")
      const method = methods.get(message.method)
      if (!method) return refuse(message.id, "unknown-method", `no method named ${message.method}`)

      const controller = new AbortController()
      inflight.set(message.id, controller)
      const progress = (data: unknown) => {
        if (inflight.get(message.id) === controller) transport.send({ type: "progress", id: message.id, data })
      }
      fork(
        Effect.suspend(() => method(message.params, { signal: controller.signal, progress })).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              inflight.delete(message.id)
              respond(message.id, controller.signal.aborted, exit)
            }),
          ),
        ),
      )
    }

    let swept = false
    const shutdown = () => {
      // Asked again, it confirms again once done, so a repeated request is not left waiting.
      if (swept) return transport.send({ type: "shutdown-complete" })
      if (closing) return
      closing = true
      for (const controller of inflight.values()) controller.abort()
      fork(
        runtime.shutdown().pipe(
          // The requests answer after their tasks end, and the main process stops listening on this confirmation.
          Effect.andThen(
            Effect.gen(function* () {
              while (inflight.size > 0) yield* Effect.sleep("20 millis")
            }).pipe(Effect.timeoutOption(REQUEST_DRAIN)),
          ),
          Effect.andThen(
            Effect.sync(() => {
              swept = true
              transport.send({ type: "shutdown-complete" })
            }),
          ),
        ),
      )
    }

    const receive = (raw: unknown) => {
      const decoded = decodeInbound(raw)
      if (Exit.isFailure(decoded)) {
        warn("GeoEngine received a malformed message", Cause.pretty(decoded.cause))
        // A request that can still be told apart is answered, or the caller waits for good.
        const id = (raw as { id?: unknown } | null)?.id
        if (
          (raw as { type?: unknown } | null)?.type === "request" &&
          Number.isInteger(id) &&
          !inflight.has(id as number)
        ) {
          refuse(id as number, "malformed", Cause.pretty(decoded.cause))
        }
        return
      }
      const message = decoded.value
      if (message.type === "request") return request(message)
      if (message.type === "cancel") return inflight.get(message.id)?.abort()
      shutdown()
    }

    const stop = transport.listen(receive)
    yield* Effect.addFinalizer(() => Effect.sync(stop))

    transport.send({ type: "ready" })
    return yield* Effect.never
  })
