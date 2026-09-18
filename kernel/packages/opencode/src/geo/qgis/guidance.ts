import * as path from "path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the guidance shown when the QGIS environment is not ready (docs/GEOKERNEL.md §8.6). The QGIS tools
 * share one environment and must say the same words, so the tool layer renders this and writes none of its own. --- */

const machineJson = () => path.join(Global.Path.config, "machine.json")

function fixable(opening: string): string {
  const shared = [
    opening,
    "",
    `Configuration file: ${machineJson()}`,
    `Required field: "qgis" — ONE location hint pointing anywhere inside the QGIS install.`,
    "",
    "GeoCode derives the interpreter, QGIS_PREFIX_PATH, GDAL_DATA, PROJ data,",
    "PYTHONPATH, plugin paths and every other variable QGIS Python needs from",
    "that single hint. You configure ONE path; GeoCode handles the rest.",
    "",
  ]
  const platform =
    process.platform === "win32"
      ? [
          "Accepted shapes (pick ONE):",
          `  the install root:        "C:\\\\Program Files\\\\QGIS 3.40.11"`,
          `  the bundled python.exe:  "C:\\\\Program Files\\\\QGIS 3.40.11\\\\apps\\\\Python312\\\\python.exe"`,
          `  the launcher bat:        "C:\\\\Program Files\\\\QGIS 3.40.11\\\\bin\\\\python-qgis-ltr.bat"`,
          "",
          "To configure, edit the file above:",
          "{",
          `  "qgis": "C:\\\\Program Files\\\\QGIS 3.40.11"`,
          "}",
          "",
          "Note for the agent:",
          "  1. Find the user's QGIS install. It is often NOT on the system",
          "     drive, and `where qgis` only finds it if it is on PATH — so do",
          "     not conclude it is missing until the other fixed drives are out:",
          `       dir "C:\\Program Files\\QGIS*"      (then D:, E: … )`,
          `       dir "C:\\OSGeo4W*"                  (then D:, E: … )`,
          "       where qgis",
          "  2. Confirm the location with the user, then write it to the file above.",
          "     GeoCode re-probes automatically after save — no restart needed.",
          "",
          "  - DO NOT install QGIS yourself (no winget/choco/installer). If it is",
          "    missing, direct the user to https://qgis.org/download/ instead.",
          "  - DO NOT write a wrapper .bat to set environment variables — point",
          "    the hint at the QGIS install itself.",
        ]
      : [
          "Accepted shapes (pick ONE):",
          `  the app bundle:   "/Applications/QGIS.app"   (or "/Applications/QGIS-LTR.app")`,
          `  the bundled python: "/Applications/QGIS.app/Contents/MacOS/bin/python3"`,
          "",
          "To configure, edit the file above:",
          "{",
          `  "qgis": "/Applications/QGIS.app"`,
          "}",
          "",
          "Note for the agent:",
          "  1. Find the user's QGIS install:",
          "       ls /Applications/QGIS*.app",
          `       mdfind "kMDItemCFBundleIdentifier == org.qgis.qgis*"`,
          "  2. Confirm the location with the user, then write it to the file above.",
          "     GeoCode re-probes automatically after save — no restart needed.",
          "",
          "  - DO NOT install QGIS yourself (no brew / .dmg automation). If it is",
          "    missing, direct the user to https://qgis.org/download/ instead.",
          "  - DO NOT write a wrapper .sh to set environment variables, and DO NOT",
          "    pre-test the python by running it — GeoCode probes after save.",
        ]
  return [...shared, ...platform, "", "Then call any QGIS tool again to see the new state."].join("\n")
}

/**
 * The prohibitions are repeated here because this copy ends in "reinstall QGIS", and an Agent told to recommend one is
 * a step away from running the installer itself. The interpreter is echoed because step 1 asks the reader to judge
 * the hint, and `GeoTool.qgisHeader` renders nothing for a status other than `ready`.
 */
function broken(symptom: string, opts?: { error?: string; interpreter?: string }): string {
  const head = [
    `${symptom} — the configured location was found, but the QGIS installation itself is not fully usable.`,
    "",
    `Configuration file: ${machineJson()}`,
    ...(opts?.interpreter ? [`Resolved interpreter: ${opts.interpreter}`] : []),
    ...(opts?.error ? ["", `Probe error: ${opts.error}`] : []),
    "",
    "Two causes account for nearly all of these:",
    "",
  ]
  const platform =
    process.platform === "win32"
      ? [
          `1. WRONG PATH — the "qgis" hint does not point at a QGIS install.`,
          `   System pythons such as C:\\Anaconda\\python.exe do not ship`,
          "   qgis.core, osgeo or Processing.",
          "",
          "   Point it at ONE of:",
          `     <install-root>                             e.g. C:\\Program Files\\QGIS 3.40.11`,
          `     <install-root>\\apps\\Python<NN>\\python.exe`,
          `     <install-root>\\bin\\python-qgis-ltr.bat    (LTR variant)`,
          "",
          "2. QGIS INSTALL BROKEN — the path is right but the install is missing",
          "   components (GDAL bindings, plugins). Reinstall from:",
          "     https://qgis.org/download/",
          "",
          "Note for the agent:",
          "  1. Check whether the hint points at a QGIS-shipped python.exe or a",
          "     launcher bat. If NOT, offer to find the QGIS install and fix the file.",
          "  2. If the path looks correct, ask the USER to reinstall QGIS from the",
          "     official site. DO NOT run any installer / package manager / winget /",
          "     choco / .exe automation yourself.",
          "  3. DO NOT write a wrapper .bat. Always point the hint at the QGIS",
          "     install itself.",
        ]
      : [
          `1. WRONG PYTHON — the "qgis" hint points at a SYSTEM python`,
          "   (/usr/bin/python3, /opt/homebrew/bin/python3, a conda env). System",
          "   pythons do not ship osgeo, qgis.core or Processing.",
          "",
          "   Point it at the app bundle, or at its bundled python:",
          "     /Applications/QGIS.app",
          "     /Applications/QGIS*.app/Contents/MacOS/bin/python3",
          "",
          "2. QGIS INSTALL BROKEN — the path is right but the install is missing",
          "   components. Reinstall from:",
          "     https://qgis.org/download/",
          "   (Use the official .dmg — third-party Homebrew cask QGIS has known",
          "    GDAL binding issues on macOS.)",
          "",
          "Note for the agent:",
          "  1. Check whether the hint is .app-bundled (matches",
          "     /Applications/QGIS*.app/Contents/MacOS/bin/python3). If NOT, offer",
          "     to find the QGIS install and fix the file.",
          "  2. If the path looks correct, ask the USER to reinstall from the",
          "     official site. DO NOT run any install command yourself (no brew,",
          "     no .dmg automation).",
          "  3. DO NOT write a wrapper .sh — point the hint at the .app directly.",
          "  4. DO NOT pre-test the python by running it yourself; GeoCode probes",
          "     after save.",
        ]
  return [
    ...head,
    ...platform,
    "",
    "Do not try to repair bindings or plugins by hand; that is not reliably",
    "fixable from here.",
    "",
    // Here "saving re-probes" would be false: config drops a block whose value is unchanged (`config/index.ts`), and
    // `POST /geo/reload` goes through the same filter, so a reinstall at the same path re-probes nothing until restart.
    `GeoCode re-probes when the "qgis" hint in machine.json CHANGES. Saving the`,
    "same value again is not a change, and nothing runs. So once the user has",
    "reinstalled:",
    "  - if the new install sits at a different path — Windows version-numbered",
    "    directories usually do — write that path here and the probe runs on save;",
    "  - if the path is unchanged, GeoCode has to be restarted before it looks",
    "    again.",
    "Then call any QGIS tool again.",
  ].join("\n")
}

/** A fully ready status returns ""; a ready one can still fail the gate when Processing or the catalog is missing. */
export function render(status: GeoEvent.QgisStatus): string {
  switch (status.status) {
    case "ready":
      if (status.catalog === "building")
        return "QGIS is ready and its algorithm catalog is still being built — the first build after a configuration change can take a while. Try again shortly."
      if (!status.processing || status.catalog === "skipped")
        return broken("QGIS's Processing framework is not available in this installation", {
          interpreter: status.interpreter,
        })
      if (status.catalog === "failed")
        return broken(`The algorithm catalog could not be built`, {
          error: status.catalogError,
          interpreter: status.interpreter,
        })
      return ""
    case "unconfigured":
      return fixable("QGIS is not configured yet.")
    case "config-error":
      return [
        `machine.json cannot be parsed: ${status.message} (${status.file}).`,
        "Every geographic capability is off until the file parses again — fix that",
        "line first; the file takes effect the moment it is saved.",
      ].join("\n")
    case "path-missing":
      return fixable(`The configured QGIS location does not exist${status.hint ? ` (${status.hint})` : ""}.`)
    case "not-qgis":
      return fixable(`The configured location is not a QGIS installation${status.hint ? ` (${status.hint})` : ""}.`)
    case "probing":
    case "resolving":
      return "QGIS is still being validated — the first probe after a configuration change can take a while. Try again shortly."
    case "gdal-missing":
      return broken("GDAL bindings cannot be imported", {
        error: status.diagnostics.error,
        interpreter: status.diagnostics.interpreter,
      })
    case "proj-broken":
      return broken("PROJ data is broken or missing", {
        error: status.diagnostics.error,
        interpreter: status.diagnostics.interpreter,
      })
    case "core-missing":
      return broken("qgis.core cannot be imported", {
        error: status.diagnostics.error,
        interpreter: status.diagnostics.interpreter,
      })
    case "probe-timeout":
      return broken("The environment probe got no response within its time limit", {
        error: status.diagnostics.error,
        interpreter: status.diagnostics.interpreter,
      })
    case "probe-failed":
      return broken("The environment probe failed before reporting", {
        error: status.diagnostics.error,
        interpreter: status.diagnostics.interpreter,
      })
  }
}

export * as QgisGuidance from "./guidance"
