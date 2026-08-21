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

/* --- GeoCode: RunGeeScript, the acting face of the GEE group
 * (docs/TOOLS.md §3, GEOKERNEL §5.9 and the §11.2 handover).
 *
 * The kernel decides whether Earth Engine can be used and runs the interpreter;
 * this layer owns what surrounds that — refusing before anything spawns, live
 * visibility while it runs, an ending that says which way it ended, and the one
 * thing unique to GEE: reporting a refusal back so the authorization layer can
 * learn from it (§5.5 真实使用兜底).
 *
 * That last one is the whole of the lazy-authorization design's other half. The
 * stored conclusion can sit on "valid" indefinitely — credentials get revoked
 * without the route changing — and no amount of polling would be worth what it
 * costs. Instead the user's own call IS the check: it is the same operation,
 * against the same remote, with the same credentials. Without the line below
 * that closes it, the loop exists only in the documentation. --- */

/** Live progress pushed to the frontend while the script runs (§11.2). */
const STREAM_BUDGET = 30_000

/**
 * The cap on the script's own output in the returned text.
 *
 * GEE is the one geographic tool where truncation is real, and the contrast
 * with RunQgisAlgorithm is the reason: an algorithm's output is a property of
 * the algorithm and the install, but this output is whatever a script the Agent
 * WROTE decides to print. A loop over a large collection can produce megabytes,
 * and nothing about the environment bounds it.
 *
 * The TAIL is kept. Where an algorithm's log builds towards its result, a
 * script that failed says why at the end — and the banner and elapsed footer
 * are appended after this, which is exactly what upstream's head-first
 * truncation would drop (tool/tool.ts).
 */
const OUTPUT_BUDGET = 60_000

/** Named in the launch-failure text, which points at the field to check. */
const machineJson = () => path.join(Global.Path.config, "machine.json")

/**
 * The module a script imported and this environment does not have.
 *
 * The setup probe checks the four packages the runtime library itself needs
 * (§5.3) — nothing more, because nothing more is knowable in advance. A script
 * that imports scikit-learn, rasterio or a plotting library therefore passes
 * the gate and fails HERE, at import time, with the gate still correctly open.
 *
 * Worth detecting because this is a failure the agent can actually repair, and
 * the one thing it needs is which interpreter to repair: the configured one,
 * never whatever `pip` resolves to on PATH (§5.11 安装纪律). A bare traceback
 * says what is missing and nothing about where it belongs.
 *
 * Both spellings: `ModuleNotFoundError` is what modern CPython raises, and the
 * older `ImportError: No module named x` still turns up from vendored code.
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
 * One shape for all the return paths.
 *
 * Flags are `?: true` — present means true, and `failed: false` is never
 * written. The frontend reads these fields and NEVER parses the output text
 * (the double-channel contract, GEOKERNEL §9.1).
 *
 * `truncated` is always present, and unlike the QGIS runner's it is a real
 * measurement rather than a standing claim. Declaring it is what keeps the
 * generic head-truncation from running over the top of an ending we already
 * trimmed from the other side.
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
    // Only for its `write` (docs/TOOLS.md §5.2): declaring `truncated` skips
    // upstream's truncation entirely, and that is also what saves the full text
    // to disk — so a tool that trims its own output has to put the rest
    // somewhere, or the trimmed part is simply gone. Upstream's directory comes
    // with a retention sweep already, which is the reason to borrow it rather
    // than invent a second place with a second lifecycle.
    const truncate = yield* Truncate.Service

    const run = Effect.fn("RunGeeScriptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context

      // Snapshotted at entry so the parameter refusals still carry the
      // environment line, and taken again after the gate because a round can
      // land while ctx.ask waits on the user (§11.2 环境头快照).
      const entryHeader = yield* GeoTool.geeHeader(status)

      /** A refusal from before any subprocess existed: never an elapsed footer. */
      const refuse = (heading: string, lines: readonly string[], metadata: Metadata) => ({
        title: heading,
        output: [entryHeader, lines.join("\n")].filter(Boolean).join("\n\n"),
        metadata,
      })

      // ---- Pre-spawn paths, none of them with an elapsed footer ----

      // Checked before the permission prompt: a malformed call is the Agent's
      // to fix, and asking the user to approve it first would put a decision
      // in front of them about something that was never going to run.
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

      /* Resolved once, here, and used everywhere below (docs/TOOLS.md §4.3).
       *
       * `script_path` was previously passed through raw to all eleven of its
       * uses — the existence check, the permission pattern, the metadata, and
       * the runner. A relative path therefore resolved against `process.cwd()`
       * rather than the instance: `existsSync` could answer about a different
       * file than the one that would run, and the pattern a permission rule had
       * to match changed shape depending on how the model happened to spell the
       * argument. Same fault OSM's writer carried before 2026-08-19, same fix,
       * and the shape is `read`'s (geo-read.ts) rather than a third one.
       *
       * The schema still asks for an absolute path. That is guidance for the
       * model; this is what holds when the guidance is not followed.
       */
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

      /* A local dead end is reported without asking anyone anything.
       *
       * Permission still comes BEFORE the gate below, and that ordering is not
       * negotiable: passing the gate performs the lazy authorization check
       * (§5.5), a real call carrying real credentials into the remote's quota
       * visibility, which must not happen for a user who has not agreed to run
       * anything. But that argument only covers the layers that need the
       * REMOTE. The local dependency chain — no configuration, an unparseable
       * machine.json, a missing interpreter, missing packages, no credentials —
       * is settled facts already sitting in the status plane, and reading them
       * costs nothing and touches no network.
       *
       * So when the chain has already stopped, this refuses here. Asking first
       * would spend the user's attention on a decision with one outcome, and
       * teach them that the prompt is a formality — which is exactly what makes
       * the prompt worthless on the day it matters.
       *
       * `geeLocalDeadEnd` re-probes before it answers, and that is load-bearing
       * rather than tidy: two of the four setup steps — installing packages,
       * running the authentication command — do not touch machine.json, so the
       * watcher never fires and only a retry can discover that the user has
       * done what they were told. See the note on it in geo-tool.ts.
       */
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
        // `title` for a file, which is the worktree-relative form `read` and
        // OSM's writer both use — so a rule written against a path matches the
        // same way whichever geographic tool touches it. The inline case gets
        // an identifier rather than `title`'s "GEE inline script": one is for
        // rule matching, the other is prose for a human, and merging them makes
        // the rule harder to write for no gain.
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

      // ---- Spawn. Every path below carries an elapsed footer ----

      let streamed = ""
      const startedAt = Date.now()

      // The same field set every later update carries, so a frontend does not
      // see `script` appear halfway through a run that had it from the start.
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
            // The live view keeps the TAIL, which is where a running script says
            // anything new — but silently dropping the head would let a watcher
            // read a fragment as the whole log, so it is marked, and this
            // metadata describes the payload it accompanies rather than the
            // final result.
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
        /* A launch that never happened is NOT one of the endings.
         *
         * It used to be filed as `crash`, which reads out as "a native library
         * segfaulted, below the Python level, uncatchable" — and carried an
         * elapsed footer for a process that never existed. Both halves were
         * wrong in the same direction: the two things that actually land here
         * are a configured interpreter that has gone away and a cache the
         * library cannot be written to, and both are fixable. Telling someone
         * their C stack blew up is telling them to give up. */
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
            // `error` is what both runners already use for "the environment is
            // in the way", and the shut gate beside this one sets it too. The
            // old build's separate `env_error` is not revived here: it would be
            // a second spelling of the same fact, on one path out of two.
            error: true,
            error_code: "LaunchFailed",
          },
        )
      }

      const result = outcome.result
      const elapsedMs = Date.now() - startedAt
      const succeeded = result.reason === "exit" && result.code === 0

      /* The loop §5.5 describes, closed here and nowhere else.
       *
       * A run refused by the remote is better evidence than any probe: it IS
       * the operation, against the same remote, with the same credentials. The
       * kernel decides whether the message is an authorization refusal at all —
       * a script that failed on its own logic must not invalidate a working
       * authorization — and updates its conclusion if it is.
       *
       * Only a script that RAN TO ITS OWN END and failed counts as evidence.
       * A killed process leaves whatever it had printed in stderr, and that
       * text was never the remote's answer to anything — a log line
       * mentioning permissions, in a run the user cancelled, would revoke a
       * working authorization on the strength of a coincidence. */
      const refusedRemotely = result.reason === "exit" && result.code !== 0 && result.stderr.trim().length > 0
      const rejected = refusedRemotely ? yield* gee.reject(result.stderr) : false
      // The conclusion just changed, so the guidance for it is available NOW.
      // Rendering it here saves the Agent a round trip to be told what this
      // very call already proved.
      const refreshed = rejected ? yield* status.current("gee") : undefined
      const authGuidance = refreshed ? GeeService.GeeGuidance.render(refreshed) : undefined

      /* Detected for the metadata channel only — the agent is told nothing.
       *
       * A script that imports something this environment lacks fails with a
       * traceback naming the module, under a header naming the interpreter.
       * That is the whole picture, and the agent reasons from it. Three
       * successive attempts to "help" here were all padding: restating the
       * module, explaining which packages the probe covers, spelling out the
       * install command. Advice of that kind narrows a capable reader into
       * following steps instead of thinking, and it is the tool's job to
       * report, not to instruct.
       *
       * The field below is a different channel with a different consumer
       * (§9.1): a surface can offer an action from it without anyone reading
       * prose for it. */
      const absent = succeeded ? undefined : missingModule(result.stderr)

      const structured = result.stderr.trim() ? GeoOutput.structuredError(result.stderr) : undefined
      const raw = structured ?? result.stderr.trim()
      // An idle stop is the one ending whose fix is a contract the script did
      // not keep, so the banner names the tool that keeps it. Without this the
      // Agent reads "no output for too long" and reaches for a bigger timeout
      // that this tool does not have.
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
      // What was trimmed still has to be reachable — from the interface, and by
      // the Agent through Grep or Read. Written only when something was
      // actually cut, so an ordinary run leaves nothing behind.
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
        // So a surface can offer the install as an action rather than asking
        // the user to read a traceback for it.
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
