import * as path from "path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"

/* --- GeoCode: the guidance the QGIS group shows an Agent when the
 * environment is not ready (GEOKERNEL §8.6; the QGIS sibling of §5.11).
 *
 * Lives in the kernel because the three QGIS tools (ReadGeoData / QgisDoc /
 * RunQgisAlgorithm) share ONE environment and ONE configuration step, so they
 * must speak with one voice — byte-for-byte, the old version's rule. The tool
 * layer renders what this returns; it never authors environment copy itself.
 *
 * Ported from the old kernel's two formatters with one deliberate adaptation:
 * the old copy taught `geocode.json`'s `qgis.python` field; the new kernel
 * reads `machine.json`'s `qgis` string — a single location hint in any of
 * five shapes (§4.2). Porting the copy without moving the target would send
 * the Agent to a file nobody reads (docs/PATHS.md §5, the write/read pairing
 * lesson).
 *
 * The split the old version discovered still holds and is the spine here:
 *   - fixable():  the Agent CAN complete this (find QGIS, write machine.json)
 *   - broken():   the Agent CANNOT (corrupted install) — verify, then
 *                 recommend reinstalling; never attempt repair
 * Both end on the same fact that closes the loop: machine.json is watched,
 * saving it re-probes automatically, no restart (§3.1). --- */

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
          "  1. Find the user's QGIS install:",
          `       dir "C:\\Program Files\\QGIS*"`,
          `       dir "C:\\OSGeo4W*"`,
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

function broken(symptom: string, error?: string): string {
  return [
    `${symptom} — the configured location was found, but the QGIS installation itself is not fully usable.`,
    ...(error ? ["", `Probe error: ${error}`] : []),
    "",
    "What the agent can realistically do:",
    `  1. Check that the "qgis" hint in ${machineJson()} points at a real QGIS`,
    "     install (pointing at a system Python instead is the most common mistake).",
    "  2. If the location is right, recommend reinstalling QGIS from",
    "     https://qgis.org/download/ to the same place — do not try to repair",
    "     bindings or plugins by hand; that is not reliably fixable from here.",
    "",
    "GeoCode re-probes automatically when machine.json is saved and after the",
    "install changes underneath it. Then call any QGIS tool again.",
  ].join("\n")
}

/** One voice for every not-ready state. A fully ready status returns "". */
export function render(status: GeoEvent.QgisStatus): string {
  switch (status.status) {
    case "ready":
      // The gate can refuse a READY environment: the catalog may still be
      // building, and the two Processing failures below were in the old
      // version's broken family from the start (ready + !processingReady,
      // ready + registry failed) — a probe can succeed against an install
      // whose Processing framework is missing or whose catalog dump errors.
      if (status.catalog === "building")
        return "QGIS is ready and its algorithm catalog is still being built — the first build after a configuration change can take a while. Try again shortly."
      if (!status.processing)
        return broken("QGIS's Processing framework is not available in this installation")
      if (status.catalog === "failed")
        return broken(`The algorithm catalog could not be built${status.catalogError ? ` (${status.catalogError})` : ""}`)
      if (status.catalog === "skipped")
        return broken("The algorithm catalog was skipped because Processing is unavailable")
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
      return fixable(
        `The configured QGIS location does not exist${status.hint ? ` (${status.hint})` : ""}.`,
      )
    case "not-qgis":
      return fixable(
        `The configured location is not a QGIS installation${status.hint ? ` (${status.hint})` : ""}.`,
      )
    case "probing":
    case "resolving":
      return "QGIS is still being validated — the first probe after a configuration change can take a while. Try again shortly."
    case "gdal-missing":
      return broken("GDAL bindings cannot be imported", status.diagnostics.error)
    case "proj-broken":
      return broken("PROJ data is broken or missing", status.diagnostics.error)
    case "core-missing":
      return broken("qgis.core cannot be imported", status.diagnostics.error)
    case "probe-timeout":
      return broken("The environment probe got no response within its time limit", status.diagnostics.error)
    case "probe-failed":
      return broken("The environment probe failed before reporting", status.diagnostics.error)
  }
}

export * as QgisGuidance from "./guidance"
