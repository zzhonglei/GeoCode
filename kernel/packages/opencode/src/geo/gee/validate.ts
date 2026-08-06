export * as GeeValidate from "./validate"

import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"

/* --- GeoCode: the remote authorization check (docs/GEOKERNEL.md §5.5).
 *
 * One real initialization plus one minimal result, which answers in a single
 * round trip three things no local check can: the credentials still work, the
 * project is bound to the service, and the interface is enabled.
 *
 * This is the ONLY call in the system that carries credentials and enters the
 * remote's quota and abuse visibility, and it costs seconds — measured at 5–6
 * against a real project on a healthy link. Everything about how it is
 * scheduled (lazily, cached by route, never on a connectivity event) follows
 * from that, and lives in the lifecycle; this module only knows how to ask and
 * how to read the answer. --- */

export const MARKER = "__GEOCODE_GEE_RUNTIME_JSON__"

/**
 * The check.
 *
 * `getInfo` after `Initialize` on purpose: initialization alone can succeed
 * locally without proving the remote accepts anything. Forcing one tiny result
 * is what makes this a verification rather than a hopeful setup call.
 */
export const SCRIPT = `
import faulthandler, sys
faulthandler.enable(file=sys.stderr)

import json, os

try:
    import ee
    project = os.environ.get("GEE_PROJECT") or ""
    if not project:
        raise RuntimeError("GEE_PROJECT was not provided to the check")
    ee.Initialize(project=project)
    ee.Number(1).getInfo()
    print("${MARKER}" + json.dumps({"ok": True}))
except Exception as e:
    print("${MARKER}" + json.dumps({"ok": False, "type": type(e).__name__, "message": str(e)}))

sys.stdout.flush()
os._exit(0)
`

/**
 * Total clock (§8.4).
 *
 * Measured at 5–6 seconds against a real project; the rest of the budget is
 * for a slow or proxied link. Generous on purpose — a false timeout here would
 * report the remote as broken when it is merely far away, and that is a worse
 * answer than making the caller wait.
 */
const TOTAL = "60 seconds"

/**
 * Attribute a rejection from its message.
 *
 * Ported from the build that survived production, where these patterns were
 * shaped by real messages. Order matters: an interface-not-enabled rejection
 * often also mentions permissions, and answering "permission denied" would
 * send the user to the wrong page of a cloud console.
 *
 * `unknown` is a real answer, not a fallback for laziness — the raw message
 * travels beside the attribution precisely because our reading of it can be
 * wrong, and the user should see what the remote actually said.
 */
export function classify(message: string): GeoEvent.GeeRejection {
  if (
    /(api|service).*(enable|enabled|disabled)|(?:enable|disabled).*(api|service)|has not been used in project/i.test(
      message,
    )
  ) {
    return "api-disabled"
  }
  if (/permission|denied|forbidden|403|not authorized|access.*denied/i.test(message)) return "permission-denied"
  if (/credential|token|unauthorized|login|oauth|authentication|invalid_grant/i.test(message)) {
    return "credentials-expired"
  }
  if (/invalid project|project .*not found|project .*does not exist|unknown project|project id/i.test(message)) {
    return "project-invalid"
  }
  return "unknown"
}

/**
 * Markers that place a failure inside the Earth Engine client stack.
 *
 * Deliberately module and exception identities, never the word "earthengine"
 * on its own: that appears in ordinary file paths, and a user whose output
 * directory is `~/earthengine/` would have every local error read as a remote
 * one. A Python traceback from a real refusal always names the exception's
 * fully qualified type or the library frame it was raised in.
 */
const EARTH_ENGINE_ORIGIN =
  /\bEEException\b|ee\.ee_exception|googleapiclient|google\.auth\b|google\.api_core|oauth2client|[/\\]ee[/\\][a-z_]+\.py/i

/**
 * Whether a FAILED RUN was refused by the remote — the guard on §5.5's loop.
 *
 * Takes the run's whole stderr, and the name says so on purpose. `classify`
 * answers a different question: given text the remote produced, what did it
 * object to. Feeding it a script's stderr instead asks it to judge text it was
 * never written for, and the words it keys on are ordinary Python words —
 * measured on real messages, five of seven common local failures came back as
 * authorization problems. `PermissionError: [Errno 13] Permission denied` on
 * an output file read as "the account lacks permission for this project";
 * `SyntaxError: invalid token` read as expired credentials and sent the user
 * to re-authenticate.
 *
 * The cost of a false positive is not a bad message: the conclusion is cached,
 * the status slot turns red, and the gate refuses the next call for the whole
 * backoff. A working setup is taken away over a typo. So the origin has to be
 * established first, and anything that cannot be placed inside the client
 * stack is left alone — which is the same principle `unknown` already encodes,
 * applied one level earlier.
 */
export function isRemoteRefusal(stderr: string): boolean {
  if (!EARTH_ENGINE_ORIGIN.test(stderr)) return false
  return classify(stderr) !== "unknown"
}

/** Run the check in the given environment, which must already carry the route. */
export function run(
  runtime: GeoRuntime.Interface,
  python: string,
  env: Record<string, string>,
  route: string | undefined,
): Effect.Effect<GeoEvent.GeeRuntime> {
  return Effect.gen(function* () {
    const result = yield* runtime
      .run({
        command: python,
        args: ["-c", SCRIPT],
        env,
        delivery: { mode: "collect" },
        clocks: { total: TOTAL },
        label: "gee:validate",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed<GeoRuntime.Result>({
            code: null,
            reason: "crash",
            stdout: "",
            stderr: error.message.split("\n")[0] ?? error.message,
            durationMs: 0,
            truncated: false,
            drainIncomplete: false,
          }),
        ),
      )

    const extracted = GeoOutput.extractMarked(result.stdout, MARKER)
    if (!extracted.ok) {
      // No verdict came back. This is not an authorization answer and must not
      // be dressed up as one — it is attributed `unknown` with whatever the
      // process actually produced.
      const why =
        result.reason === "timeout"
          ? `the authorization check exceeded ${TOTAL}`
          : "the authorization check produced no verdict"
      return { status: "failed", reason: "unknown", message: `${why}\n${tail(result)}` } satisfies GeoEvent.GeeRuntime
    }

    const payload = extracted.value as { ok?: unknown; message?: unknown }
    if (payload.ok === true) return { status: "valid", route } satisfies GeoEvent.GeeRuntime

    const message = typeof payload.message === "string" && payload.message ? payload.message : "(no message)"
    return { status: "failed", reason: classify(message), message } satisfies GeoEvent.GeeRuntime
  })
}

function tail(result: GeoRuntime.Result): string {
  const ending =
    result.reason !== "exit" || result.code !== 0
      ? `[process ${result.reason}${result.code !== null ? `, exit code ${result.code}` : ""}]\n`
      : ""
  const joined = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n")
  return ending + (GeoOutput.truncate(joined, 4_000).text || "(no output at all)")
}
