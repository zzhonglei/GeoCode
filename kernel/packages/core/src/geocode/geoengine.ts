export * as GeoEngine from "./geoengine.js"

import { Data, Effect, Exit, Schema, Stream } from "effect"

/** The shell server's route for the geo tools; it shares the agent tools' callback token and address. */
const PATH = "/api/geocode/geo-tool"

const Line = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), data: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("result"), ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("result"),
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String, details: Schema.optionalKey(Schema.Unknown) }),
  }),
])
const decodeLine = Schema.decodeUnknownExit(Schema.fromJsonString(Line))

/** GeoEngine's refusal, or `unavailable` when it could not be asked at all. */
export class Failure extends Data.TaggedError("GeoEngineFailure")<{
  readonly code: string
  readonly message: string
  readonly details?: unknown
}> {}

const unavailable = (message: string) => new Failure({ code: "unavailable", message })

/** What GeoAgent is told of a failure inside GeoCode, whose details are for the log, not for it. */
export const UNAVAILABLE = "The QGIS tools are not available right now; restarting GeoCode may fix it."

/**
 * Calls a GeoEngine method through the shell server, handing on its progress as GeoEngine reports it. An interrupted
 * call closes the request, which cancels the task. No timeout: a task runs as long as GeoEngine lets it.
 */
export const call = (
  method: string,
  params: unknown,
  progress: (data: unknown) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const callback = process.env.OPENCHAMBER_AGENT_TOOL_URL
    const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
    if (!callback || !token)
      return yield* unavailable("GeoEngine is only reachable from the kernel the GeoCode app runs")
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(new URL(PATH, callback), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ method, params }),
          signal,
          // Bun ends a request after 360 seconds by default; a task may take longer.
          timeout: false,
        }),
      catch: (error) => unavailable(`the shell server did not answer: ${String(error)}`),
    })
    const body = response.body
    if (!response.ok || !body) return yield* unavailable(`the shell server refused the call (HTTP ${response.status})`)
    let outcome: Extract<typeof Line.Type, { type: "result" }> | undefined
    yield* Stream.fromReadableStream({
      evaluate: () => body,
      onError: (error) => unavailable(`the answer broke off: ${String(error)}`),
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((text) => {
        const decoded = decodeLine(text)
        if (Exit.isFailure(decoded)) return Effect.void
        if (decoded.value.type === "progress") return progress(decoded.value.data)
        outcome = decoded.value
        return Effect.void
      }),
    )
    if (!outcome) return yield* unavailable("the answer ended without a result")
    if (!outcome.ok) return yield* new Failure(outcome.error)
    return outcome.result
  })
