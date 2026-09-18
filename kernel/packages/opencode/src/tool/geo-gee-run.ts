import { existsSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { GeeService, GeoRuntime, GeoStatus } from "@/geo"
import { GeoOutput } from "@/geo/runtime"
import { GeoTool } from "./geo-tool"
import { InstanceState } from "@/effect/instance-state"
import { Truncate } from "./truncate"
import DESCRIPTION from "./geo-gee-run.txt"

/* --- GeoCode: RunGeeScript (docs/TOOLS.md §3). Nothing else calls `gee.reject`, so the lazy-authorization loop
 * closes at that call or nowhere (GEOKERNEL §5.5). --- */

const STREAM_BUDGET = 30_000

/** The Agent writes the script, so nothing but this bounds what it prints into the result (docs/TOOLS.md §5.2). */
const OUTPUT_BUDGET = 60_000

const machineJson = () => path.join(Global.Path.config, "machine.json")

/** Two patterns: a hand-raised `ImportError: No module named x` has neither the modern class name nor quotes. */
export function missingModule(stderr: string): string | undefined {
  const modern = stderr.match(/ModuleNotFoundError: No module named ['"]([\w.]+)['"]/)
  if (modern) return modern[1]
  const legacy = stderr.match(/ImportError: No module named ['"]?([\w.]+)['"]?/)
  return legacy?.[1]
}

export const Parameters = Schema.Struct({
  script: Schema.optional(Schema.String).annotate({
    description:
      "Inline Python code string for short, one-off GEE tasks (band info, collection size, simple computations).",
  }),
  script_path: Schema.optional(Schema.String).annotate({
    description: "Absolute path to a .py file for multi-step pipelines or scripts the user wants preserved.",
  }),
})

/**
 * Flags such as `failed` are present-means-true, never written as false. `truncated` is always set, which switches off
 * upstream's head truncation before it can cut the banner and the elapsed footer off the end (docs/TOOLS.md §5.1).
 */
type Metadata = {
  [key: string]: unknown
  truncated: boolean
}

export const RunGeeScriptTool = Tool.define<
  typeof Parameters,
  Metadata,
  GeeService.Service | GeoRuntime.Service | GeoStatus.Service | Truncate.Service
>(
  "RunGeeScript",
  Effect.gen(function* () {
    const gee = yield* GeeService.Service
    const runtime = yield* GeoRuntime.Service
    const status = yield* GeoStatus.Service
    // Only for `write`: skipping upstream's truncation also skips its saving of the full text to disk.
    const truncate = yield* Truncate.Service

    const run = Effect.fn("RunGeeScriptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context

      // Taken at entry for the refusals, and again after the gate, since a probe can land while the user is asked.
      const entryHeader = yield* GeoTool.geeHeader(status)

      const refuse = (heading: string, lines: readonly string[], metadata: Metadata) => ({
        title: heading,
        output: [entryHeader, lines.join("\n")].filter(Boolean).join("\n\n"),
        metadata,
      })

      // ---- Pre-spawn paths, none of them with an elapsed footer ----

      // Before the permission prompt: there is nothing to approve in a call that cannot run.
      if (!params.script && !params.script_path) {
        return refuse(
          "Invalid parameters",
          [
            "Neither `script` nor `script_path` was provided — Python was NOT invoked.",
            "This is a tool-call formatting error on your end (the agent), not a GEE or tool failure.",
            "Fix: pass `script` with inline Python for a quick query, or `script_path` with an absolute .py path.",
          ],
          { truncated: false, error_code: "InvalidParameters", param_error: true },
        )
      }

      if (params.script && params.script_path) {
        return refuse(
          "Invalid parameters",
          [
            "Both `script` and `script_path` were provided, and exactly one is expected — Python was NOT invoked.",
            "This is a tool-call formatting error on your end (the agent), not a GEE or tool failure.",
            "Fix: drop whichever one is not the script you meant to run.",
          ],
          { truncated: false, error_code: "InvalidParameters", param_error: true },
        )
      }

      // Resolved once against the instance directory, so the existence check, the permission pattern and the runner
      // all name the same file (docs/TOOLS.md §4.3).
      let scriptPath = params.script_path
      if (scriptPath && !path.isAbsolute(scriptPath)) scriptPath = path.resolve(instance.directory, scriptPath)
      if (scriptPath && process.platform === "win32") scriptPath = FSUtil.normalizePath(scriptPath)

      if (scriptPath && !existsSync(scriptPath)) {
        return refuse(
          "Script not found",
          [
            `No file at \`script_path\` — Python was NOT invoked: ${scriptPath}`,
            "Fix: write the script to that path first, or correct the path. It must be absolute.",
          ],
          {
            truncated: false,
            mode: "file",
            script: scriptPath,
            error_code: "ScriptNotFound",
            param_error: true,
          },
        )
      }

      const mode: "inline" | "file" = scriptPath ? "file" : "inline"
      const title = scriptPath ? path.relative(instance.worktree, scriptPath) : "GEE inline script"

      // A local dead end is refused before the prompt, but the gate stays after it: the gate can make a real remote
      // call with the user's credentials, which needs the user's consent first (GEOKERNEL §5.5).
      const deadEnd = yield* GeoTool.geeLocalDeadEnd(gee, status)
      if (deadEnd) {
        return refuse("Earth Engine unavailable", [GeeService.GeeGuidance.render(deadEnd)], {
          truncated: false,
          mode,
          ...(scriptPath ? { script: scriptPath } : {}),
          error: true,
          geoStatus: GeoTool.geeGateStatus(deadEnd),
        })
      }

      yield* ctx.ask({
        permission: "gee",
        // An identifier for inline scripts rather than `title`'s prose, since rules match on it (docs/TOOLS.md §4.3).
        patterns: [scriptPath ? title : "inline_script"],
        always: ["*"],
        metadata: scriptPath ? { script: scriptPath } : {},
      })

      const gate = yield* GeoTool.settledGeeGate(gee, ctx.abort)
      if (!gate.ok) {
        return refuse(
          "Earth Engine unavailable",
          [
            GeeService.GeeGuidance.render(gate.status) ||
              "Earth Engine settled while this call was checking it — call the tool again.",
          ],
          {
            truncated: false,
            mode,
            ...(scriptPath ? { script: scriptPath } : {}),
            error: true,
            geoStatus: GeoTool.geeGateStatus(gate.status),
          },
        )
      }

      const header = yield* GeoTool.geeHeader(status)

      // ---- Spawn. Every path below carries an elapsed footer, except a launch that never happened ----

      let streamed = ""
      const startedAt = Date.now()

      yield* ctx.metadata({
        title,
        metadata: {
          truncated: false,
          mode,
          ...(scriptPath ? { script: scriptPath } : {}),
          output: "",
        },
      })

      const outcome = yield* GeeService.GeeExecutor.run(runtime, gate.environment, {
        script: params.script,
        scriptPath: scriptPath,
        abort: ctx.abort,
        cwd: instance.directory,
        onChunk: (chunk) =>
          Effect.gen(function* () {
            streamed += chunk
            // `truncated` here describes this live payload, not the result.
            const live = GeoOutput.truncate(streamed, STREAM_BUDGET)
            yield* ctx.metadata({
              title,
              metadata: {
                truncated: live.truncated,
                mode,
                ...(scriptPath ? { script: scriptPath } : {}),
                output: live.truncated ? `…(earlier output trimmed)\n${live.text}` : live.text,
              },
            })
          }),
      }).pipe(
        // The error channel means no process ran, so it gets neither a termination banner nor an elapsed footer.
        Effect.catch((error) => Effect.succeed({ launchFailure: error.message })),
      )

      if ("launchFailure" in outcome) {
        return refuse(
          "Earth Engine could not start",
          [
            "Python could not be started, so the script never ran.",
            "",
            outcome.launchFailure,
            "",
            "This is the environment, not the script. Two things cause it:",
            `  1. The configured interpreter is gone or is not executable — check "gee.python" in ${machineJson()}.`,
            "  2. The runtime library could not be written to the cache directory (a full disk, or its permissions).",
          ],
          {
            truncated: false,
            mode,
            ...(scriptPath ? { script: scriptPath } : {}),
            error: true,
            error_code: "LaunchFailed",
          },
        )
      }

      const result = outcome.result
      const elapsedMs = Date.now() - startedAt
      const succeeded = result.reason === "exit" && result.code === 0

      // Only a run that exited on its own counts as evidence: stderr left by a killed or cancelled run could revoke a
      // working authorization by coincidence.
      const refusedRemotely = result.reason === "exit" && result.code !== 0 && result.stderr.trim().length > 0
      const rejected = refusedRemotely ? yield* gee.reject(result.stderr) : false
      const refreshed = rejected ? yield* status.current("gee") : undefined
      const authGuidance = refreshed ? GeeService.GeeGuidance.render(refreshed) : undefined

      // Metadata only: in the text, the traceback already names the module.
      const absent = succeeded ? undefined : missingModule(result.stderr)

      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      // Names heartbeat(), since this tool exposes no timeout for the Agent to raise.
      const idleNote =
        result.reason === "idle"
          ? `The limit is ${GeeService.GeeExecutor.IDLE_FLOOR_SECONDS}s of silence. Wrap long GEE calls in heartbeat() — a script that does not report progress cannot be told apart from one that has hung.`
          : undefined
      const detail =
        result.reason === "exit"
          ? raw || `Script failed (exit ${result.code})`
          : [idleNote, raw].filter(Boolean).join("\n")
      const banner = succeeded ? "" : GeoTool.terminationBanner(result.reason, detail)

      const body = GeoOutput.truncate(streamed.trim(), OUTPUT_BUDGET)
      const outputPath = body.truncated ? yield* truncate.write(streamed) : undefined

      const metadata: Metadata = {
        truncated: body.truncated,
        mode,
        ...(scriptPath ? { script: scriptPath } : {}),
        ...(outputPath ? { outputPath } : {}),
        elapsed_ms: elapsedMs,
        ...(result.code !== null ? { exit_code: result.code } : {}),
        ...(result.drainIncomplete ? { partial: true } : {}),
        ...(rejected ? { auth_rejected: true } : {}),
        ...(absent ? { missing_module: absent } : {}),
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
            metadata.error_code = "ScriptFailed"
            metadata.failed = true
          }
          break
      }

      const output = [
        header,
        body.truncated
          ? `…(earlier output trimmed — the full output was saved to ${outputPath}; use Grep or Read on it)\n${body.text}`
          : body.text || undefined,
        banner || undefined,
        authGuidance || undefined,
        GeoTool.elapsedFooter(elapsedMs),
      ]
        .filter(Boolean)
        .join("\n\n")

      return { title, output, metadata }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
