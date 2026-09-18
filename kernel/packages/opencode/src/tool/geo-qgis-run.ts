import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoRuntime, GeoStatus } from "@/geo"
import { GeoOutput } from "@/geo/runtime"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./geo-qgis-run.txt"

/* --- GeoCode: RunQgisAlgorithm (docs/TOOLS.md §3). Every refusal before the spawn says QGIS was not invoked, whose
 * fault it is and what to change, since a bare "Invalid parameters" reads as QGIS rejecting the call. --- */

const STREAM_BUDGET = 30_000

/**
 * The parameters travel in argv and Windows caps a whole command line at 32767 characters. Enforced on every
 * platform, so a call cannot pass on macOS and fail on Windows.
 */
export const PARAMETERS_LIMIT = 24_000

/** Just under Windows' 260-character path limit, so abbreviation usually falls on inlined geometries, not paths. */
const VALUE_LIMIT = 256

/**
 * The permission pattern: the algorithm and every argument, with paths absolute and verbatim so the user can see one
 * outside the working directory (docs/TOOLS.md §4.3).
 */
export function describeCall(algorithm: string, parameters: Record<string, unknown>): string {
  const rendered = Object.entries(parameters).map(([key, value]) => {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" || value === null
          ? String(value)
          : JSON.stringify(value)
    const shown =
      text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…(+${text.length - VALUE_LIMIT} chars)` : text
    return `${key}=${shown}`
  })
  return `${algorithm}(${rendered.join(", ")})`
}

export const Parameters = Schema.Struct({
  algorithm: Schema.String.annotate({
    description: "The QGIS algorithm ID, e.g. 'native:xxxx', 'gdal:xxxxxx'",
  }),
  parameters: Schema.String.annotate({
    description:
      'JSON string of algorithm parameters. Example: \'{"Parameter 0": "/path/to/input.shp", "Parameter 1": 100, "Parameter 2": "/path/to/output.shp"}\'',
  }),
  // Enforced as an IDLE clock, not a total; the floor and default mirror the executor's `IDLE_FLOOR_SECONDS` and
  // `IDLE_DEFAULT_SECONDS`.
  timeout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10))
    .pipe(Schema.withDecodingDefault(Effect.succeed(60)))
    .annotate({
      description:
        "Timeout in seconds (default: 60). You can adjust it based on the dataset size and computational load.",
    }),
})

/**
 * `truncated` is set, and false, on every result: setting it stops tool.ts's head truncation, which would cut the
 * ending, the error and the elapsed footer off the tail (docs/TOOLS.md §5).
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const RunQgisAlgorithmTool = Tool.define<
  typeof Parameters,
  Metadata,
  GeoQgis.Service | GeoQgis.QgisCatalog.Service | GeoRuntime.Service | GeoStatus.Service
>(
  "RunQgisAlgorithm",
  Effect.gen(function* () {
    const qgis = yield* GeoQgis.Service
    const catalog = yield* GeoQgis.QgisCatalog.Service
    const runtime = yield* GeoRuntime.Service
    const status = yield* GeoStatus.Service

    const run = Effect.fn("RunQgisAlgorithmTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context

      // Taken at entry for the refusals, and again after the gate, since a round can land while the user is asked.
      const entryHeader = yield* GeoTool.qgisHeader(status)

      const refuse = (heading: string, lines: readonly string[], metadata: Metadata) => ({
        title: heading,
        output: [entryHeader, lines.join("\n")].filter(Boolean).join("\n\n"),
        metadata,
      })

      // ---- Pre-spawn refusals, none of them with an elapsed footer ----

      let parsed: unknown
      try {
        parsed = JSON.parse(params.parameters)
      } catch {
        return refuse(
          "Invalid parameters",
          [
            "Cannot parse `parameters` as JSON — QGIS was NOT invoked.",
            `Received: ${params.parameters}`,
            "This is a tool-call formatting error on your end (the agent), not a QGIS or tool failure.",
            "Fix: serialize your params object to a JSON string and pass that string as the `parameters` value.",
            `Example: '{"INPUT": "/path/in.shp", "DISTANCE": 100, "OUTPUT": "/path/out.shp"}'`,
          ],
          {
            truncated: false,
            algorithm: params.algorithm,
            error_code: "InvalidParameters",
            param_error: true,
          },
        )
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        const got = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed
        return refuse(
          "Invalid parameters",
          [
            `\`parameters\` decoded to ${got}, but it must decode to a JSON object (key-value pairs) — QGIS was NOT invoked.`,
            "This is a tool-call formatting error on your end (the agent), not a QGIS or tool failure.",
            `Fix: pass a JSON-stringified object as a string, e.g.: '{"INPUT": "/path/in.shp", "DISTANCE": 100, "OUTPUT": "/path/out.shp"}'`,
          ],
          {
            truncated: false,
            algorithm: params.algorithm,
            error_code: "InvalidParameters",
            param_error: true,
          },
        )
      }

      if (params.parameters.length > PARAMETERS_LIMIT) {
        return refuse(
          "Parameters too long",
          [
            `\`parameters\` is ${params.parameters.length} characters, past the ${PARAMETERS_LIMIT} limit — QGIS was NOT invoked.`,
            "Parameters are passed on the command line, which the operating system caps; beyond that point the run",
            "fails in a way nothing downstream can attribute, so it is refused here where the cause is still known.",
            "Fix: write the large value to a file and pass its path, or process the data in smaller pieces.",
          ],
          {
            truncated: false,
            algorithm: params.algorithm,
            error_code: "ParametersTooLong",
            param_error: true,
          },
        )
      }

      // Before the prompt, so no one approves a call the environment cannot run (docs/TOOLS.md §3).
      const deadEnd = yield* GeoTool.qgisLocalDeadEnd(status)
      if (deadEnd) {
        return refuse("QGIS environment unavailable", [GeoQgis.QgisGuidance.render(deadEnd)], {
          truncated: false,
          algorithm: params.algorithm,
          error: true,
          geoStatus: GeoTool.gateStatus(deadEnd),
        })
      }

      // Deliberately no `external_directory` ask: this prompt already shows every path, and a boundary guard would see
      // only the ones `QgisDestination.reserve` recognises (docs/TOOLS.md §4.3). Upstream keeps approvals in memory,
      // so `always: ["*"]` lasts until restart.
      yield* ctx.ask({
        permission: "qgis",
        patterns: [describeCall(params.algorithm, parsed as Record<string, unknown>)],
        always: ["*"],
        metadata: { algorithm: params.algorithm, parameters: parsed },
      })

      const gate = yield* GeoTool.settledQgisGate(qgis, ctx.abort)
      if (!gate.ok) {
        return refuse(
          "QGIS environment unavailable",
          [
            GeoQgis.QgisGuidance.render(gate.status) ||
              "The QGIS environment settled while this call was checking it — call the tool again.",
          ],
          {
            truncated: false,
            algorithm: params.algorithm,
            error: true,
            geoStatus: GeoTool.gateStatus(gate.status),
          },
        )
      }

      // Read before the run: a configuration change empties the catalog.
      const known = yield* catalog.get(params.algorithm)
      const header = yield* GeoTool.qgisHeader(status)

      const nearest = known ? [] : yield* catalog.suggest(params.algorithm, "algorithm")
      const hints = GeoQgis.QgisExecutor.precheck(params.algorithm, known, parsed as Record<string, unknown>, nearest)
      const parameterTrouble = hints.some(
        (hint) =>
          hint.kind === "unknown-parameter" || hint.kind === "missing-required" || hint.kind === "invalid-choice",
      )
      // Authored here: the runner script names no tools (docs/GEOKERNEL.md §11).
      const pointer = !known
        ? `Pre-flight: use QgisDoc with action="search" to find the algorithm you mean.`
        : parameterTrouble
          ? `Pre-flight: see QgisDoc with action="read", algorithm="${known.id}" for the full parameter schema.`
          : undefined
      const precheck =
        hints.length > 0
          ? [...hints.map((hint) => `Pre-flight: ${hint.message}`), ...(pointer ? [pointer] : [])].join("\n")
          : undefined

      // Reserved before the spawn: undo does not reach geographic data, so a taken output name is numbered, never
      // overwritten (docs/GEOKERNEL.md §12).
      const reservation = yield* Effect.result(
        Effect.try({
          try: () => GeoQgis.QgisDestination.reserve(known, parsed as Record<string, unknown>),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      )
      if (reservation._tag === "Failure") {
        return refuse(
          "Output path unavailable",
          ["A free name for an output could not be found — QGIS was NOT invoked.", "", reservation.failure.message],
          {
            truncated: false,
            algorithm: params.algorithm,
            error_code: "OutputUnavailable",
            error: true,
          },
        )
      }
      const reserved = reservation.success

      GeoQgis.QgisDestination.ensureParents(reserved)
      const destinations = GeoQgis.QgisDestination.apply(parsed as Record<string, unknown>, reserved)

      // ---- Spawn ----

      let streamed = ""
      let label: string | undefined
      const startedAt = Date.now()

      const result = yield* GeoQgis.QgisExecutor.runAlgorithm(runtime, gate.environment, {
        // The canonical id: lookup accepts short forms and display names, but QGIS resolves full ids only.
        algorithm: known?.id ?? params.algorithm,
        // The re-pointed parameters, never `parsed`, whose output names may already be taken.
        parameters: destinations,
        idleSeconds: params.timeout,
        abort: ctx.abort,
        cwd: instance.directory,
        onChunk: (chunk) =>
          Effect.gen(function* () {
            streamed += chunk
            label = label ?? GeoQgis.QgisExecutor.displayName(streamed)
            // `truncated` here describes this live payload, not the result.
            const live = GeoOutput.truncate(streamed, STREAM_BUDGET)
            yield* ctx.metadata({
              title: label ?? params.algorithm,
              metadata: {
                truncated: live.truncated,
                algorithm: params.algorithm,
                ...(label ? { display_name: label } : {}),
                output: live.truncated ? `…(earlier output trimmed)\n${live.text}` : live.text,
              },
            })
          }),
      }).pipe(
        // The error channel means no process ran, so it gets neither the crash banner nor an elapsed footer.
        Effect.catch((error) => Effect.succeed({ launchFailure: error.message })),
      )

      if ("launchFailure" in result) {
        return refuse(
          "QGIS could not start",
          [
            "The QGIS interpreter could not be started, so the algorithm never ran.",
            "",
            result.launchFailure,
            "",
            "The environment passed its check moments ago, so this is something that",
            "changed underneath it: the installation was moved or removed, or the",
            "cache directory the runner script is written to is full or unwritable.",
          ],
          {
            truncated: false,
            algorithm: params.algorithm,
            error_code: "LaunchFailed",
            error: true,
          },
        )
      }

      const elapsedMs = Date.now() - startedAt
      label = label ?? GeoQgis.QgisExecutor.displayName(streamed)
      const succeeded = result.reason === "exit" && result.code === 0

      const settled = succeeded ? GeoQgis.QgisDestination.settle(reserved) : reserved
      const relocated = GeoQgis.QgisDestination.report(settled)

      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      const idleNote =
        result.reason === "idle"
          ? `The limit was ${params.timeout}s of silence; raise \`timeout\` for large datasets or slow algorithms.`
          : undefined
      const detail =
        result.reason === "exit"
          ? raw || `Script failed (exit ${result.code})`
          : [idleNote, raw].filter(Boolean).join("\n")
      const banner = succeeded ? "" : GeoTool.terminationBanner(result.reason, detail)

      const metadata: Metadata = {
        truncated: false,
        algorithm: params.algorithm,
        ...(label ? { display_name: label } : {}),
        ...(known ? { resolved_algorithm: known.id } : {}),
        elapsed_ms: elapsedMs,
        idle_limit_seconds: params.timeout,
        // Present even when empty, so an empty array says pre-flight ran and found nothing.
        precheck: hints,
        // `landed` first: QGIS may have appended its own extension to the path it was given.
        ...(settled.length > 0
          ? { destinations: settled.map((item) => ({ parameter: item.parameter, path: item.landed ?? item.actual })) }
          : {}),
        ...(result.code !== null ? { exit_code: result.code } : {}),
        ...(result.drainIncomplete ? { partial: true } : {}),
      }
      switch (result.reason) {
        case "abort":
          metadata.error_code = "Aborted"
          metadata.aborted = true
          metadata.partial = true
          break
        case "idle":
        case "timeout":
          metadata.error_code = "IdleTimeout"
          metadata.timed_out = true
          metadata.partial = true
          break
        case "crash":
          metadata.error_code = "Crashed"
          metadata.failed = true
          metadata.partial = true
          break
        case "output-limit":
          metadata.error_code = "OutputLimit"
          metadata.partial = true
          break
        case "exit":
          if (result.code !== 0) {
            metadata.error_code = "AlgorithmFailed"
            metadata.failed = true
          }
          break
      }

      const output = [
        header,
        precheck,
        streamed.trim() || undefined,
        succeeded ? relocated : undefined,
        banner || undefined,
        GeoTool.elapsedFooter(elapsedMs),
      ]
        .filter(Boolean)
        .join("\n\n")

      return { title: label ?? params.algorithm, output, metadata }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
