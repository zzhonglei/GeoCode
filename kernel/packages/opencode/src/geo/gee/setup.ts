export * as GeeSetup from "./setup"

import { existsSync } from "node:fs"
import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import type { MachineSchema } from "../config/schema"
import { NetRoute } from "../net/route"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { GeeDeps } from "./deps"

/* --- GeoCode: the local dependency chain (docs/GEOKERNEL.md §5.3).
 *
 * Four checks in dependency order, short-circuited at the first gap, so the
 * guidance can say "step N of 4" instead of handing the user a list of
 * problems to sort out themselves (§5.11). Where the chain stops is where the
 * guidance starts — the two are the same structure seen from two ends.
 *
 * Two of the four never start a subprocess: the interpreter is a file
 * existence question, and the project identifier is a config read. Only the
 * middle two — packages and credentials — need Python, and they share one
 * spawn.
 *
 * EVERYTHING HERE IS OFFLINE. No network route is injected, no project
 * identifier is passed. The conclusion "this machine is set up" must not
 * change because a cable was unplugged; mixing the two would put network
 * weather into a local fact and send the user to fix the wrong thing. --- */

/** One marker line, same protocol as every other script in the kernel (§4.3 principle 7). */
export const MARKER = "__GEOCODE_GEE_SETUP_JSON__"

/**
 * The probe.
 *
 * Three properties are load-bearing:
 *
 * - **The manifest arrives as DATA**, parsed by the script, never spliced into
 *   it as import statements. A package name is a string from a list we edit;
 *   pasting strings into source is how a list edit becomes a syntax error.
 * - **Credentials are judged by the file's existence**, not by asking the
 *   client library. Its quiet authentication path does not raise, may simply
 *   do nothing, and reports success either way — which turns "no credentials"
 *   into "ready" and moves the failure to the middle of the user's first
 *   script. Whether the credentials still WORK is a remote fact and belongs to
 *   §5.5, not here.
 * - **The fault handler is enabled before any third-party import.** These
 *   packages carry native extensions; a broken one segfaults during load,
 *   where no except block will ever see it.
 */
export const SCRIPT = `
import faulthandler, sys
faulthandler.enable(file=sys.stderr)

import json, os, importlib

DEPS = json.loads(sys.argv[1])

report = {"missing": []}
for dep in DEPS:
    try:
        module = importlib.import_module(dep["module"])
        if dep["module"] == "ee":
            report["version"] = getattr(module, "__version__", "")
    except Exception:
        report["missing"].append(dep["pkg"])

if report["missing"]:
    print("${MARKER}" + json.dumps(report))
    sys.stdout.flush()
    os._exit(0)

# Presence only. Validity is a remote fact (section 5.5).
report["credentials"] = False
try:
    from ee import oauth
    report["credentials"] = os.path.exists(oauth.get_credentials_path())
except Exception as e:
    report["credentials_error"] = str(e)

print("${MARKER}" + json.dumps(report))
sys.stdout.flush()
os._exit(0)
`

/**
 * Fixed total clock (§8.4, kernel-known tier).
 *
 * Measured at 1.4–1.7s warm on a real conda environment with all four
 * packages; the budget is for the cold case, where these imports pull tens of
 * megabytes of native extensions off a slow disk on first use.
 */
const TOTAL = "30 seconds"

/** Every proxy spelling, blanked. Net owns the list of spellings (§3.3). */
const offline: Record<string, string> = Object.fromEntries(NetRoute.PROXY_KEYS.map((key) => [key, ""]))

/** What the probe found. */
export type Report = {
  readonly missing: readonly string[]
  readonly credentials: boolean
  readonly version?: string
  /** Set when the credential check itself broke — which is not the same as no credentials. */
  readonly credentials_error?: string
}

/**
 * Run the four checks and return the state to publish.
 *
 * The whole chain lives in one function because the order IS the design: each
 * step is only meaningful once the previous one passed, and splitting them
 * across call sites would let a caller ask them out of order.
 */
export function probe(
  runtime: GeoRuntime.Interface,
  block: MachineSchema.Gee | undefined,
): Effect.Effect<GeoEvent.GeeSetup> {
  return Effect.gen(function* () {
    // 1. The interpreter. No subprocess: there is nothing to run yet.
    const python = block?.python?.trim()
    if (!python) return { status: "unconfigured" as const }
    if (!existsSync(python)) return { status: "python-missing" as const, python }

    // 2 and 3. Packages and credentials, in one spawn.
    const result = yield* runtime
      .run({
        command: python,
        args: ["-c", SCRIPT, JSON.stringify(GeeDeps.DEPS.map((dep) => ({ pkg: dep.pkg, module: dep.module })))],
        // Offline, and made offline EXPLICITLY (§5.3). The subprocess
        // inherits our environment, so a proxy the user's shell exported
        // would reach it — and while this probe dials nothing itself, an
        // import that does would then hang on a dead proxy until the clock
        // kills it, and the user would be told their local environment is
        // broken when only the network is. Blanked rather than left unset,
        // because unset does not survive inheritance (§3.3 直连需显式清除);
        // unconditionally, because "this probe has no proxy" should not
        // depend on what our own process happened to be started with. No
        // project either — that is checked here, from config, and the probe
        // has no business knowing it.
        env: { ...offline, PYTHONUTF8: "1", PYTHONIOENCODING: "UTF-8" },
        delivery: { mode: "collect" },
        clocks: { total: TOTAL },
        label: "gee:setup",
      })
      .pipe(
        Effect.catch((error) =>
          // A spawn that fails outright — the path names a directory, or a
          // file that is not executable. Normal user input, not a defect.
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
      if (result.reason === "timeout") return { status: "probe-timeout" as const }
      const detail =
        extracted.kind === "invalid"
          ? `the setup report would not parse (${extracted.error})`
          : "the setup probe produced no report"
      return { status: "probe-failed" as const, error: `${detail}\n${tail(result)}` }
    }

    const report = extracted.value as Partial<Report>
    if (!Array.isArray(report.missing)) {
      return { status: "probe-failed" as const, error: `the setup report was not the expected shape\n${tail(result)}` }
    }
    if (report.missing.length > 0) {
      return { status: "packages-missing" as const, missing: report.missing.map(String) }
    }
    // A broken check is not a missing credential. The client library imported
    // fine a moment ago, so failing to reach its credential path means the
    // installation is wrong — and answering "credentials-missing" would send
    // the user to run an authentication command that cannot fix it.
    if (typeof report.credentials_error === "string") {
      return {
        status: "probe-failed" as const,
        error: `the credential check could not run: ${report.credentials_error}`,
      }
    }
    if (report.credentials !== true) return { status: "credentials-missing" as const }

    // 4. The project identifier — a config read, and last in the chain
    // because only an authorized run needs it (§5.2).
    if (!block?.project?.trim()) return { status: "project-missing" as const }

    return { status: "ready" as const }
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
