export * as QgisProbe from "./probe"

import { Effect } from "effect"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisBootstrap } from "./bootstrap"

/* --- GeoCode: the environment probe (docs/GEOKERNEL.md §4.6, §4.13).
 *
 * Verifies CAPABILITY, not import (§4.3 principle 6): each step exercises the
 * thing users actually need, and each failure names one class of install
 * problem. --- */

export const MARKER = "__GEOCODE_PROBE_JSON__"

/**
 * The probe script. Ported behaviour, with each §4.13 constraint visible:
 *
 * - The fault handler comes on BEFORE any geo import (constraint 4). A broken
 *   install segfaults during native library load, which no except-block can
 *   see; enabled first, the handler at least writes the native stack to
 *   stderr, and stderr rides the diagnostics. The old probe lacked this and a
 *   segfault produced nothing at all.
 * - The result rides ONE marked line, and the script hard-exits immediately
 *   after flushing it (constraints 1 and 3): the toolkit and its plugins
 *   write to stdout at import, init AND teardown, so whole-output parsing is
 *   unreliable and the teardown chatter is skipped outright. The hard exit is
 *   also why a successful probe always reports exit code zero.
 * - Step 1 failing emits immediately (§4.6): the later steps cannot succeed
 *   without bindings, and their stacked errors would only mislead.
 * - Step 2 exists separately from step 1 (§4.3 principle 6): bindings import
 *   fine on installs whose projection database is missing or mismatched, and
 *   without this step that surfaces weeks later on the first custom CRS. The
 *   transform must produce FINITE numbers — some failure modes return NaN
 *   rather than raising.
 */
export const SCRIPT = `
import faulthandler
faulthandler.enable()
import json, math, os, sys, traceback

def _emit(payload):
    print("${MARKER}" + json.dumps(payload))
    sys.stdout.flush()
    os._exit(0)

info = {"pythonVersion": ".".join(map(str, sys.version_info[:3]))}

# Step 1: GDAL bindings.
try:
    from osgeo import gdal, osr
    info["gdalVersion"] = gdal.__version__
except Exception as e:
    info["gdalVersion"] = ""
    info["gdalError"] = repr(e)
    info["gdalTraceback"] = traceback.format_exc()
    _emit(info)

# Step 2: a real transform from a custom projected CRS to a geographic one.
try:
    src = osr.SpatialReference()
    src_err = src.ImportFromProj4("+proj=lcc +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs")
    if src_err not in (0, None):
        raise RuntimeError(f"ImportFromProj4 failed with code {src_err}")
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst = osr.SpatialReference()
    dst_err = dst.ImportFromEPSG(4326)
    if dst_err not in (0, None):
        raise RuntimeError(f"ImportFromEPSG(4326) failed with code {dst_err}")
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(src, dst)
    lon, lat, _ = transform.TransformPoint(500000, 4000000)
    if not math.isfinite(lon) or not math.isfinite(lat):
        raise RuntimeError(f"TransformPoint returned non-finite coordinates: {lon}, {lat}")
    info["projTransformReady"] = True
except Exception as e:
    info["projTransformReady"] = False
    info["projTransformError"] = str(e)
    info["projTransformTraceback"] = traceback.format_exc()

# Steps 3 and 4: the core imports headless, and the algorithm framework
# initialises. Framework failure is NOT an environment failure — it degrades
# one capability dimension (§4.7).
try:
    from qgis.core import QgsApplication, Qgis
    info["qgisVersion"] = Qgis.version() if hasattr(Qgis, 'version') else Qgis.QGIS_VERSION
    qgs = QgsApplication([], False)
    qgs.initQgis()
    from qgis import processing
    from processing.core.Processing import Processing
    Processing.initialize()
    info["processingReady"] = True
    qgs.exitQgis()
except Exception as e:
    info["qgisVersion"] = info.get("qgisVersion", "")
    info["processingReady"] = False
    info["processingError"] = str(e)
    info["qgisTraceback"] = traceback.format_exc()

_emit(info)
`

/** What the script reports, when it reports at all. */
export interface Report {
  readonly pythonVersion: string
  readonly gdalVersion: string
  readonly gdalTraceback?: string
  readonly gdalError?: string
  readonly projTransformReady?: boolean
  readonly projTransformError?: string
  readonly projTransformTraceback?: string
  readonly qgisVersion?: string
  readonly qgisTraceback?: string
  readonly processingReady?: boolean
  readonly processingError?: string
}

export type Outcome =
  | { readonly ok: true; readonly report: Report }
  | {
      readonly ok: false
      readonly failure: "gdal-missing" | "proj-broken" | "core-missing" | "probe-timeout" | "probe-failed"
      /** The step's own words, or the raw output when the script never spoke. */
      readonly detail: string
      /** True when the marker never appeared — the interpreter died before any step. */
      readonly startupCrash: boolean
      readonly report?: Report
    }

/** The probe is our own code with fully known behaviour: fixed total clock (§8.4). */
const TOTAL = "30 seconds"

export function run(
  runtime: GeoRuntime.Interface,
  interpreter: string,
  env: Record<string, string>,
  dllDirectories: readonly string[],
): Effect.Effect<Outcome> {
  return Effect.gen(function* () {
    const result = yield* runtime
      .run({
        command: interpreter,
        args: ["-c", QgisBootstrap.wrapInline(SCRIPT, dllDirectories)],
        env,
        delivery: { mode: "collect" },
        clocks: { total: TOTAL },
        label: "qgis:probe",
      })
      .pipe(
        Effect.catch((error) =>
          // A spawn that fails outright — interpreter path is a directory, not
          // executable, missing — is a probe failure with the error as detail,
          // not a defect: the hint is user input and this is a normal outcome.
          Effect.succeed<GeoRuntime.Result>({
            code: null,
            reason: "crash",
            stdout: "",
            // First line only: the spawner's message embeds the entire command
            // including the probe script, and a thousand-line error helps nobody.
            stderr: error.message.split("\n")[0] ?? error.message,
            durationMs: 0,
            truncated: false,
            drainIncomplete: false,
          }),
        ),
      )

    // The marker outranks the exit code: a report that made it out is a
    // verdict regardless of how the interpreter ended, and in practice the
    // hard exit guarantees code zero whenever the marker exists.
    const extracted = GeoOutput.extractMarked(result.stdout, MARKER)

    if (!extracted.ok) {
      if (result.reason === "timeout") {
        return {
          ok: false,
          failure: "probe-timeout",
          detail: `probe exceeded ${TOTAL}; partial output:\n${tail(result.stdout, result.stderr)}`,
          startupCrash: false,
        } satisfies Outcome
      }
      // Marker present but unreadable is ITS OWN case (§4.6 failure grading):
      // the interpreter demonstrably started and reached its emit, so calling
      // it a startup crash both drops the parse error and — worse — trips the
      // macOS unknown-layout retry, a spurious thirty-second stdlib search
      // keyed precisely on startupCrash.
      if (extracted.kind === "invalid") {
        return {
          ok: false,
          failure: "probe-failed",
          detail: `probe result would not parse (${extracted.error}); raw output:\n${tail(result.stdout, result.stderr)}`,
          startupCrash: false,
        } satisfies Outcome
      }
      // No marker: the script never reached its emit — interpreter startup
      // failure, segfault, kill. The RAW output is the diagnosis and must
      // reach the reader intact (§4.6 失败分级); with the fault handler on,
      // stderr carries the native stack for the segfault case. The process's
      // own ending is part of that diagnosis (§4.6 row 1), so it leads.
      const ending =
        result.reason !== "exit" || result.code !== 0
          ? `[process ${result.reason}${result.code !== null ? `, exit code ${result.code}` : ""}]\n`
          : ""
      return {
        ok: false,
        failure: "probe-failed",
        detail: ending + (tail(result.stdout, result.stderr) || "(no output at all)"),
        startupCrash: true,
      } satisfies Outcome
    }

    const report = extracted.value as Report

    if (!report.gdalVersion) {
      return {
        ok: false,
        failure: "gdal-missing",
        detail: report.gdalTraceback ?? report.gdalError ?? "(no traceback captured)",
        startupCrash: false,
        report,
      } satisfies Outcome
    }
    if (!report.projTransformReady) {
      return {
        ok: false,
        failure: "proj-broken",
        detail: report.projTransformTraceback ?? report.projTransformError ?? "(no traceback captured)",
        startupCrash: false,
        report,
      } satisfies Outcome
    }
    if (!report.qgisVersion) {
      return {
        ok: false,
        failure: "core-missing",
        detail: report.qgisTraceback ?? report.processingError ?? "(no traceback captured)",
        startupCrash: false,
        report,
      } satisfies Outcome
    }

    return { ok: true, report } satisfies Outcome
  })
}

function tail(stdout: string, stderr: string): string {
  const joined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n")
  return GeoOutput.truncate(joined, 8_000).text
}
