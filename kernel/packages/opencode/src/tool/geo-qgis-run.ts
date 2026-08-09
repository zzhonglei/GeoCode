import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GeoQgis, GeoRuntime, GeoStatus } from "@/geo"
import { GeoOutput } from "@/geo/runtime"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./geo-qgis-run.txt"

/* --- GeoCode: RunQgisAlgorithm, the acting face of the QGIS group
 * (docs/TOOLS.md §3, GEOKERNEL §4.12 and the §11.2 handover).
 *
 * The first tool in GeoCode that changes the user's disk. Running the
 * subprocess is the kernel's job and is not re-decided here; what this layer
 * owns is everything around it — attribution when it fails, visibility while it
 * runs, and an ending that says which of six ways it ended.
 *
 * Attribution is the part worth spending words on. A failure here has three
 * possible owners and the model's next move differs for each: its own
 * tool-call formatting, the user's environment, or the algorithm and its data.
 * The old build learned this the hard way — a bare "Invalid parameters" reads
 * as "QGIS rejected me", and the model goes hunting for a bug in the tool that
 * does not exist. So every pre-spawn refusal states plainly that QGIS was never
 * invoked, whose fault that is, and what to change. --- */

/** Live progress pushed to the frontend while the algorithm runs (§11.2). */
const STREAM_BUDGET = 30_000

/**
 * The longest `parameters` string that may reach the command line.
 *
 * Parameters travel as an argv entry (§4.12), and Windows caps a whole command
 * line at 32767 characters. The runner script itself measures 3890 bytes, about
 * a ninth of that; a parameter set with inlined geometry or a long table can
 * still cross the line, and crossing it does not fail with a message — the
 * spawn fails in a way nothing downstream can attribute. Checked on BOTH
 * platforms, so a call that works on the developer's Mac cannot be the thing
 * that breaks on a user's Windows box.
 */
export const PARAMETERS_LIMIT = 24_000

export const Parameters = Schema.Struct({
  algorithm: Schema.String.annotate({
    description: "The QGIS algorithm ID, e.g. 'native:xxxx', 'gdal:xxxxxx'",
  }),
  parameters: Schema.String.annotate({
    description:
      'JSON string of algorithm parameters. Example: \'{"Parameter 0": "/path/to/input.shp", "Parameter 1": 100, "Parameter 2": "/path/to/output.shp"}\'',
  }),
  // Presented as a total duration but enforced as an IDLE clock (§8.4, and the
  // deliberate deviation recorded in §11.2): an algorithm that keeps reporting
  // progress may run far longer than this, which is what makes long jobs
  // possible at all. The floor mirrors the kernel's.
  timeout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10))
    .pipe(Schema.withDecodingDefault(Effect.succeed(60)))
    .annotate({
      description:
        "Timeout in seconds (default: 60). You can adjust it based on the dataset size and computational load.",
    }),
})

/**
 * One shape for all ten return paths.
 *
 * Flags are `?: true` — present means true, and `failed: false` is never
 * written. The frontend reads these fields and NEVER parses the output text
 * (the double-channel contract, GEOKERNEL §9.1), so anything it needs has to be
 * here and not only in the prose.
 *
 * `truncated` is always present and always false, and that is a claim, not a
 * placeholder: an algorithm's result does not scale with the user's data.
 * Processing writes per-feature findings into OUTPUT LAYERS and keeps the
 * feedback log for progress and a summary — measured at under 1 KB for five
 * thousand invalid polygons through checkvalidity, fixgeometries and buffer.
 * Saying so is what keeps the generic head-truncation from running
 * (tool/tool.ts:131), and that matters because it keeps the head and drops the
 * tail — where the ending, the error and the elapsed footer all live.
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

      // Snapshotted at entry so the refusals below still carry the environment
      // line, and taken again after the gate because a round can land while
      // ctx.ask is waiting on the user (§11.2 环境头快照). Never sent through
      // ctx.metadata — that path broadcasts live (§9.1).
      const entryHeader = yield* GeoTool.qgisHeader(status)

      /** A refusal from before any subprocess existed: never an elapsed footer. */
      const refuse = (heading: string, lines: readonly string[], metadata: Metadata) => ({
        title: heading,
        output: [entryHeader, lines.join("\n")].filter(Boolean).join("\n\n"),
        metadata,
      })

      // ---- Four pre-spawn paths, none of them with an elapsed footer ----

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

      yield* ctx.ask({
        permission: "qgis",
        patterns: [params.algorithm],
        always: ["*"],
        metadata: { algorithm: params.algorithm },
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
            // The same field set ReadGeoData and QgisDoc return for a shut
            // gate: one event, one shape. `error` plus the status name says
            // everything a caller needs, so a third flag meaning the same
            // thing only invites the three tools to drift apart.
            truncated: false,
            algorithm: params.algorithm,
            error: true,
            geoStatus: GeoTool.gateStatus(gate.status),
          },
        )
      }

      // The catalog is a LIVE reference, unlike the environment which is handed
      // over as a snapshot: a configuration change empties it (§4.8 阶段依附).
      // Reading it here, in the same breath as the gate, is what §11.2 asks for
      // — read it after the run and it may already be gone.
      const known = yield* catalog.get(params.algorithm)
      const header = yield* GeoTool.qgisHeader(status)

      // Millisecond pre-flight against that metadata. It ADVISES and never
      // blocks (§4.12): the exported metadata cannot express every constraint,
      // and blocking on its gaps would turn them into "the user cannot run
      // this". The in-script check reads the live registry and complements it.
      const nearest = known ? [] : yield* catalog.suggest(params.algorithm, "algorithm")
      const hints = GeoQgis.QgisExecutor.precheck(params.algorithm, known, parsed as Record<string, unknown>, nearest)
      // A finding the caller can act on needs somewhere to go. The old build
      // appended a pointer to EVERY parameter-level warning; the runner script
      // no longer names tools itself (§11.2), so both pointers have to come
      // from this layer — the search one when the algorithm is unknown, the
      // schema one when the algorithm is known but its parameters are not.
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

      // ---- Spawn. Every path below carries an elapsed footer ----

      let streamed = ""
      let label: string | undefined
      const startedAt = Date.now()

      const result = yield* GeoQgis.QgisExecutor.runAlgorithm(runtime, gate.environment, {
        // The canonical id, not what the caller typed: lookup tolerates short
        // forms and display names (§4.11) but QGIS resolves full ids only, so
        // passing the raw key through would let a call clear pre-flight and
        // then fail inside the interpreter for a reason nothing can explain.
        algorithm: known?.id ?? params.algorithm,
        parameters: parsed as Record<string, unknown>,
        idleSeconds: params.timeout,
        abort: ctx.abort,
        cwd: instance.directory,
        onChunk: (chunk) =>
          Effect.gen(function* () {
            streamed += chunk
            label = label ?? GeoQgis.QgisExecutor.displayName(streamed)
            // The live view keeps the TAIL, which is where a running algorithm
            // says anything new — but silently dropping the head would let a
            // watcher read a partial log as the whole one, so it is marked, and
            // this metadata reports the state of the payload it accompanies
            // rather than that of the final result.
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
        /* A launch that never happened is NOT one of the endings.
         *
         * Filing it as `crash` reads out as "a native library segfaulted,
         * below the Python level, uncatchable", with an elapsed footer for a
         * process that never existed. What actually lands here is an
         * interpreter that went away between the gate and the spawn, or a
         * script that could not be written to the cache — both fixable, and
         * neither helped by being told the C stack blew up. */
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

      // A script that fails deliberately emits one JSON object with an `error`
      // field; showing that sentence beats showing the traceback around it.
      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      // An idle stop is the one ending whose fix is a number, so the number has
      // to be in the answer: "it went quiet for too long" without saying how
      // long leaves the caller with nothing to raise.
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
        // Present whenever pre-flight actually ran, even as an empty array: the
        // frontend has to tell "checked, nothing to report" from "never got
        // that far", and an absent field is the only honest way to say the
        // second.
        precheck: hints,
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

      // Four parts, in the order the old build settled on: what ran it, what we
      // warned about before it started, what it said, and how it ended.
      const output = [
        header,
        precheck,
        streamed.trim() || undefined,
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
