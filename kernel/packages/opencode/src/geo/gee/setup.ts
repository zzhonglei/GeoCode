export * as GeeSetup from "./setup"

import { existsSync } from "node:fs"
import { Effect } from "effect"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import type { MachineSchema } from "../config/schema"
import { NetRoute } from "../net/route"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { GeeDeps } from "./deps"

/* --- GeoCode: the local dependency chain — four checks in dependency order, short-circuited at the first gap, so
 * where the chain stops is where the guidance starts (docs/GEOKERNEL.md §5.3, §5.11). --- */

/** One marker line, same protocol as every other script in the kernel (§4.3 principle 7). */
export const MARKER = "__GEOCODE_GEE_SETUP_JSON__"

/** faulthandler first: these packages carry native extensions, and a segfault during import reaches no `except`. */
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
    except ImportError:
        # Genuinely absent. Installing it is the fix, and the guidance says so.
        report["missing"].append(dep["pkg"])
    except Exception as e:
        # Present but unusable — an ABI mismatch against the installed GDAL, a
        # native library that will not load, a half-written install. Reporting
        # this as "missing" sends the user to install what they already have,
        # and the sentence that would have explained it is thrown away. The
        # broad catch stays, because a raising import must not kill the probe.
        report["broken"] = {"pkg": dep["pkg"], "error": type(e).__name__ + ": " + str(e)}
        break

if report.get("broken") or report["missing"]:
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

/** Fixed total (§8.4): warm runs measure 1.4–1.7s; the rest is for the cold import of native extensions. */
const TOTAL = "30 seconds"

/** Every proxy spelling, blanked. Net owns the list of spellings (§3.3). */
const offline: Record<string, string> = Object.fromEntries(NetRoute.PROXY_KEYS.map((key) => [key, ""]))

export type Report = {
  readonly missing: readonly string[]
  readonly credentials: boolean
  readonly version?: string
  /** Set when the credential check itself broke — which is not the same as no credentials. */
  readonly credentials_error?: string
  /** Installed and still unimportable — apart from `missing` because `pip install` does nothing for it. */
  readonly broken?: { readonly pkg: string; readonly error: string }
}

export function probe(
  runtime: GeoRuntime.Interface,
  block: MachineSchema.Gee | undefined,
): Effect.Effect<GeoEvent.GeeSetup> {
  return Effect.gen(function* () {
    // 1. The interpreter — a file check; there is nothing to run a probe with yet.
    const python = block?.python?.trim()
    if (!python) return { status: "unconfigured" as const }
    if (!existsSync(python)) return { status: "python-missing" as const, python }

    // 2 and 3. Packages and credentials, in one spawn.
    const result = yield* runtime
      .run({
        command: python,
        args: ["-c", SCRIPT, JSON.stringify(GeeDeps.DEPS.map((dep) => ({ pkg: dep.pkg, module: dep.module })))],
        // Blanked rather than left unset, because the subprocess inherits our environment (§3.3 直连需显式清除): an
        // ambient proxy plus one import that dials out is a probe timeout, reported as a broken local environment.
        env: { ...offline, PYTHONUTF8: "1", PYTHONIOENCODING: "UTF-8" },
        delivery: { mode: "collect" },
        clocks: { total: TOTAL },
        label: "gee:setup",
      })
      .pipe(
        Effect.catch((error) =>
          // A spawn that never starts — the path names a directory, or a file that is not executable. Normal input,
          // so it is graded rather than raised.
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
    // Not `packages-missing`, whose fix is an install that would do nothing here, and not `probe-failed` — this
    // probe answered, and named the package.
    if (report.broken) {
      return {
        status: "packages-broken" as const,
        python,
        pkg: String(report.broken.pkg),
        error: String(report.broken.error),
      }
    }
    if (report.missing.length > 0) {
      return { status: "packages-missing" as const, python, missing: report.missing.map(String) }
    }
    // The client library imported a moment ago, so a credential path we cannot reach is a broken install, not a
    // missing credential — and `credentials-missing` sends the user to an authentication command that cannot fix it.
    if (typeof report.credentials_error === "string") {
      return {
        status: "probe-failed" as const,
        error: `the credential check could not run: ${report.credentials_error}`,
      }
    }
    if (report.credentials !== true) return { status: "credentials-missing" as const, python }

    // 4. The project — a config read, last because it decides authorization rather than whether Python runs (§5.2).
    const project = block?.project?.trim()
    if (!project) return { status: "project-missing" as const }

    // `ready` carries the three facts the environment header and the guidance render; neither can look them up.
    return {
      status: "ready" as const,
      python,
      project,
      version: typeof report.version === "string" && report.version ? report.version : undefined,
    }
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
