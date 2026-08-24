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

/* --- GeoCode: RunGeeScript, the acting face of the GEE group (docs/TOOLS.md §3, GEOKERNEL §5.9).
 *
 * The kernel decides whether Earth Engine can be used and runs the interpreter; refusing before anything spawns,
 * live visibility, the ending banner and the `reject` call below belong here. Nothing else in the tree calls
 * `reject`, so §5.5's lazy-authorization loop is closed at that line or nowhere (§11.2 接线). --- */

/** Cap on the live `ctx.metadata` payload; the returned text is capped separately below. */
const STREAM_BUDGET = 30_000

/**
 * Cap on the script's own output in the returned text (docs/TOOLS.md §5.2). The Agent writes the script, so unlike
 * an algorithm's log nothing about the environment bounds what it prints.
 */
const OUTPUT_BUDGET = 60_000

const machineJson = () => path.join(Global.Path.config, "machine.json")

/**
 * The module a script imported and this environment does not have. The setup probe covers only the four packages
 * the runtime library itself needs (§5.3), so anything else a script imports passes the gate and fails here at
 * import time. Two spellings, because a hand-raised `ImportError: No module named x` carries neither the modern
 * class name nor the quotes.
 */
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
 * One shape for all the return paths. Flags are `?: true` — present means true, and `failed: false` is never
 * written. `truncated` is required because declaring it is what switches off upstream's head truncation, which
 * would cut the banner and the elapsed footer off the end (docs/TOOLS.md §5.1).
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
    // Only for its `write`: declaring `truncated` skips upstream's truncation, and that path is also what saves the
    // full text to disk, so a tool that trims its own output has to put the rest somewhere (docs/TOOLS.md §5.1).
    const truncate = yield* Truncate.Service

    const run = Effect.fn("RunGeeScriptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context

      // Taken at entry so the parameter refusals carry the environment line too, and again after the gate because
      // a probe can land while ctx.ask waits on the user (§11.2 环境头快照).
      const entryHeader = yield* GeoTool.geeHeader(status)

      const refuse = (heading: string, lines: readonly string[], metadata: Metadata) => ({
        title: heading,
        output: [entryHeader, lines.join("\n")].filter(Boolean).join("\n\n"),
        metadata,
      })

      // ---- Pre-spawn paths, none of them with an elapsed footer ----

      // Before the permission prompt: a malformed call is the Agent's to fix, and there is nothing for the user to
      // approve about a call that was never going to run.
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

      /* Resolved once and used everywhere below, in `read`'s shape (docs/TOOLS.md §4.3): passed through raw, a
       * relative path would resolve against `process.cwd()`, so the existence check, the permission pattern and the
       * runner could each be talking about a different file. The schema asking for an absolute path is guidance to
       * the model; this is what holds when it is not followed. */
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

      /* A settled LOCAL dead end is refused without asking anyone anything (docs/TOOLS.md §3) — it is already in
       * the status plane, and reading it touches no network.
       *
       * The remote gate below stays AFTER the prompt instead: passing it performs the lazy authorization check
       * (§5.5), a real call with real credentials, which must not happen for a user who has not agreed to run
       * anything. */
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
        // The worktree-relative `title` for a file, an identifier for the inline case rather than `title`'s prose:
        // a rule has to match on this (docs/TOOLS.md §4.3).
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

      // The same field set every later update carries, so `script` never appears halfway through a run that had it
      // from the start.
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
            // Marked, because dropping the head silently would let a watcher read a fragment as the whole log.
            // This `truncated` describes the payload it accompanies, not the final result.
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
        /* A launch that never happened is not one of the five endings: no process ran, so it gets neither a
         * termination banner nor an elapsed footer. */
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
            // `error`, the same field the shut gate above sets: one spelling for "the environment is in the way".
            error: true,
            error_code: "LaunchFailed",
          },
        )
      }

      const result = outcome.result
      const elapsedMs = Date.now() - startedAt
      const succeeded = result.reason === "exit" && result.code === 0

      /* The §5.5 loop, closed here and nowhere else. Only a script that ran to its own end and failed counts as
       * evidence: a killed process leaves whatever it had printed in stderr, and a log line mentioning permissions
       * in a run the user cancelled would revoke a working authorization on a coincidence. Whether the message is
       * an authorization refusal at all is the kernel's to decide. */
      const refusedRemotely = result.reason === "exit" && result.code !== 0 && result.stderr.trim().length > 0
      const rejected = refusedRemotely ? yield* gee.reject(result.stderr) : false
      // The conclusion just changed, so rendering its guidance here saves the Agent a round trip to be told what
      // this very call already proved.
      const refreshed = rejected ? yield* status.current("gee") : undefined
      const authGuidance = refreshed ? GeeService.GeeGuidance.render(refreshed) : undefined

      // For the metadata channel only: nothing is added to the agent's text, where the traceback already names the
      // module and the header above it names the interpreter.
      const absent = succeeded ? undefined : missingModule(result.stderr)

      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      // The fix for an idle stop is a contract the script did not keep, so the banner names it; otherwise the Agent
      // reads "no output for too long" and reaches for a timeout this tool does not expose.
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
      // What was trimmed still has to be reachable by Grep or Read, and only then, so an ordinary run leaves
      // nothing behind.
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
        // So a surface can offer the install as an action rather than asking the user to read a traceback for it.
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
