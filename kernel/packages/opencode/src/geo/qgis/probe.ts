export * as QgisProbe from "./probe"

import { Effect } from "effect"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisBootstrap } from "./bootstrap"

/* --- GeoCode: the environment probe (docs/GEOKERNEL.md §4.6). Step 2 transforms a coordinate rather than importing
 * the projection library, which imports fine with its database missing. --- */

export const MARKER = "__GEOCODE_PROBE_JSON__"

/**
 * Fault handler first, because a segfault during native library load is invisible to except; hard exit after the
 * marked line, which is why a probe that reports always exits zero. Step 2 checks for finite results, since some
 * broken projection setups return NaN rather than an error.
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
      readonly detail: string
      /** No marker, and no timeout: the interpreter never got that far. Keys the macOS unknown-layout retry. */
      readonly startupCrash: boolean
      readonly report?: Report
    }

/** Our own script, so a fixed total clock (§8.4). */
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
          // The interpreter path is derived, not verified, so a spawn that fails outright is an ordinary probe failure.
          Effect.succeed<GeoRuntime.Result>({
            code: null,
            reason: "crash",
            stdout: "",
            // First line only: the spawner puts the whole command in its message, probe script included.
            stderr: error.message.split("\n")[0] ?? error.message,
            durationMs: 0,
            truncated: false,
            drainIncomplete: false,
          }),
        ),
      )

    // The marker outranks the exit code: a report that made it out is the verdict, however the interpreter ended.
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
      // Not a startup crash: the interpreter reached its emit, and startupCrash would send resolution off into the
      // macOS stdlib search.
      if (extracted.kind === "invalid") {
        return {
          ok: false,
          failure: "probe-failed",
          detail: `probe result would not parse (${extracted.error}); raw output:\n${tail(result.stdout, result.stderr)}`,
          startupCrash: false,
        } satisfies Outcome
      }
      // No marker: the raw output is the diagnosis, and how the process ended is part of it, so it leads.
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
