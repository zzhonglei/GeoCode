export * as GeeValidate from "./validate"

import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"

/* --- GeoCode: the remote authorization check; scheduling and caching are the lifecycle's
 * (docs/GEOKERNEL.md §5.5). --- */

export const MARKER = "__GEOCODE_GEE_RUNTIME_JSON__"

/** `getInfo` after `Initialize`: initialization alone can succeed locally without the remote accepting anything. */
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

/** Fixed total (§8.4) against a call measured at 5–6s: a link that is merely slow must not read as a dead remote. */
const TOTAL = "60 seconds"

/**
 * Ordered, because the patterns overlap: `permission-denied` matches the "permission" api-disabled rejections arrive
 * with, and it would send the user to the wrong page of a cloud console.
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

/** Module and exception identities, never the bare word: `~/earthengine/` in a path is not an origin. */
const EARTH_ENGINE_ORIGIN =
  /\bEEException\b|ee\.ee_exception|googleapiclient|google\.auth\b|google\.api_core|oauth2client|[/\\]ee[/\\][a-z_]+\.py/i

/** Origin first: `classify` keys on ordinary words, and a false positive shuts the gate for the whole backoff. */
export function isRemoteRefusal(stderr: string): boolean {
  if (!EARTH_ENGINE_ORIGIN.test(stderr)) return false
  return classify(stderr) !== "unknown"
}

/** `env` must already carry Net's route and `GEE_PROJECT`; the script reads the project from the environment. */
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
      // No verdict is not an authorization answer, so it is `unknown` rather than classified from the output.
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
