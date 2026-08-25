import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoRuntime, GeoStatus } from "@/geo"
import { GeoOutput } from "@/geo/runtime"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./geo-qgis-run.txt"

/* --- GeoCode: RunQgisAlgorithm, the acting face of the QGIS group (docs/TOOLS.md §3, GEOKERNEL §4.12, §11).
 *
 * Running the subprocess is the kernel's job; what this layer owns is attribution. A bare "Invalid parameters" reads
 * as "QGIS rejected me", so every pre-spawn refusal says QGIS was never invoked, whose fault it is and what to
 * change. --- */

/** Characters of live output the metadata channel carries while the algorithm runs (§11). */
const STREAM_BUDGET = 30_000

/**
 * Parameters ride an argv entry alongside the runner script itself (§4.12), and Windows caps a whole command line at
 * 32767 characters; past that the spawn fails in a way nothing downstream can attribute. Enforced on both platforms,
 * so a call cannot pass on the developer's Mac and break on a user's Windows box.
 */
export const PARAMETERS_LIMIT = 24_000

/**
 * The longest a single parameter value may be before the prompt abbreviates it, sized against Windows' 260-character
 * path cap so that what gets cut is an inlined geometry rather than a path the user is being asked to judge. The
 * remainder is counted into the text, never dropped silently.
 */
const VALUE_LIMIT = 256

/**
 * The call as the user will be asked about it — the algorithm and every argument, the way upstream's `bash` puts the
 * command itself in the pattern rather than a category (docs/TOOLS.md §4.3). Paths stay absolute and verbatim:
 * whether one sits outside the working directory is the single thing this prompt exists to let the user judge, and
 * a relative form is exactly what would hide it.
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
  // Presented as a total duration but enforced as an IDLE clock (§8.4, §11): an algorithm that keeps reporting
  // progress may run far longer than this, which is what makes long jobs possible at all. The floor and the default
  // are the executor's own `IDLE_FLOOR_SECONDS` and `IDLE_DEFAULT_SECONDS`.
  timeout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10))
    .pipe(Schema.withDecodingDefault(Effect.succeed(60)))
    .annotate({
      description:
        "Timeout in seconds (default: 60). You can adjust it based on the dataset size and computational load.",
    }),
})

/**
 * One shape for every return path; the frontend reads these fields and never parses the output text (GEOKERNEL
 * §9.1). `truncated` is always present and always false, which is a statement rather than a placeholder: setting
 * the field at all is what stops tool.ts's generic truncation, and that one keeps the head and drops the tail —
 * where the ending, the error and the elapsed footer live (docs/TOOLS.md §5).
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

      // Snapshotted at entry so the refusals below still carry the environment line, and taken again after the gate
      // because a round can land while ctx.ask is waiting on the user (§11 环境头快照).
      const entryHeader = yield* GeoTool.qgisHeader(status)

      /** A refusal from before any subprocess existed: never an elapsed footer. */
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

      // The environment, before the prompt: a user is never asked to approve an operation that was never going to
      // run either way (docs/TOOLS.md §3). Reading the settled verdict starts no probe; only the gate below waits.
      const deadEnd = yield* GeoTool.qgisLocalDeadEnd(status)
      if (deadEnd) {
        return refuse("QGIS environment unavailable", [GeoQgis.QgisGuidance.render(deadEnd)], {
          truncated: false,
          algorithm: params.algorithm,
          error: true,
          geoStatus: GeoTool.gateStatus(deadEnd),
        })
      }

      /* The only prompt this tool raises, and deliberately no second `external_directory` ask the way `read`,
       * `write` and `bash` each have one: a boundary prompt reports a directory where this reports the algorithm and
       * every path it was given, and it could only ever see what `QgisDestination.reserve` sees, which is nothing
       * for the algorithms that write through a parameter the catalog does not call a destination (docs/TOOLS.md
       * §4.3). `always: ["*"]` keeps it to once per app run — upstream holds approvals in InstanceState, in memory.
       */
      yield* ctx.ask({
        permission: "qgis",
        patterns: [describeCall(params.algorithm, parsed as Record<string, unknown>)],
        always: ["*"],
        // What a frontend renders the request from; the prose channel is never parsed (§9.1).
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
            // The field set ReadGeoData and QgisDoc also return for a shut gate: `error` plus the status name, so a
            // third flag meaning the same thing cannot let the three drift apart.
            truncated: false,
            algorithm: params.algorithm,
            error: true,
            geoStatus: GeoTool.gateStatus(gate.status),
          },
        )
      }

      // Read before the run rather than after: the catalog is a live reference, and a configuration change empties
      // it (§4.8 阶段依附).
      const known = yield* catalog.get(params.algorithm)
      const header = yield* GeoTool.qgisHeader(status)

      const nearest = known ? [] : yield* catalog.suggest(params.algorithm, "algorithm")
      const hints = GeoQgis.QgisExecutor.precheck(params.algorithm, known, parsed as Record<string, unknown>, nearest)
      // The runner script names no tools itself (§11), so the pointer comes from this layer: search when the
      // algorithm is unknown, the schema when the algorithm is known but its parameters are not.
      const parameterTrouble = hints.some(
        (hint) =>
          hint.kind === "unknown-parameter" || hint.kind === "missing-required" || hint.kind === "invalid-choice",
      )
      const pointer = !known
        ? `Pre-flight: use QgisDoc with action="search" to find the algorithm you mean.`
        : parameterTrouble
          ? `Pre-flight: see QgisDoc with action="read", algorithm="${known.id}" for the full parameter schema.`
          : undefined
      const precheck =
        hints.length > 0
          ? [...hints.map((hint) => `Pre-flight: ${hint.message}`), ...(pointer ? [pointer] : [])].join("\n")
          : undefined

      /* Settle where the outputs go before anything is spawned (§4.12): undo does not reach what this tool writes,
       * since geographic data is kept out of the snapshot repository by design (§10.1 #6), so an overwritten scene
       * is gone with nothing to restore it from. The kernel numbers a taken name rather than refusing. */
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
        // The canonical id, not what the caller typed: lookup tolerates short forms and display names (§4.11) but
        // QGIS resolves full ids only, so the raw key would clear pre-flight and then fail inside the interpreter.
        algorithm: known?.id ?? params.algorithm,
        // Already re-pointed, so the path in the report and the path on disk cannot come apart.
        parameters: destinations,
        idleSeconds: params.timeout,
        abort: ctx.abort,
        cwd: instance.directory,
        onChunk: (chunk) =>
          Effect.gen(function* () {
            streamed += chunk
            label = label ?? GeoQgis.QgisExecutor.displayName(streamed)
            // The live view keeps the TAIL, where a running algorithm says anything new, and marks the drop so a
            // watcher cannot read a partial log as the whole one. `truncated` here describes this payload, not the
            // final result.
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
        /* A launch that never happened is not one of the endings: filing it as `crash` would read out as a native
         * segfault below the Python level, with an elapsed footer for a process that never existed. Every ending the
         * runtime knows arrives as a Result and its reason; the error channel is the spawn not happening. */
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

      // Where the outputs really are, which is only knowable now: QGIS writes `result.gpkg` for an OUTPUT of
      // `result`. A failed run is left as reserved — nothing was written, so resolving would only invent a file.
      const settled = succeeded ? GeoQgis.QgisDestination.settle(reserved) : reserved
      const relocated = GeoQgis.QgisDestination.report(settled)

      // The script's own error sentence when it wrote one, in place of the traceback around it.
      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      // An idle stop is the one ending whose fix is a number, so the number has to be in the answer.
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
        // Present whenever pre-flight ran, even as an empty array: an absent field is the only way to say "never
        // got that far".
        precheck: hints,
        // Every recognised output, where the prose below names only the ones worth a sentence (§9.1). `landed`
        // first, because the reserved path is what QGIS was TOLD and it may have appended its own extension on the
        // way to disk — this is the channel a frontend opens files from.
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

      // Where the data landed joins the parts only on success: a run that ended any other way wrote nothing to
      // point at, and naming a path for it would send the caller looking for a file that is not there.
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
