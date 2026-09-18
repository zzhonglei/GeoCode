import { describe, expect, test } from "bun:test"
import * as path from "path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { QgisGuidance } from "../../src/geo/qgis/guidance"

/* Tripwires for the QGIS group's one voice (GEOKERNEL §8.6): that the guidance keeps teaching machine.json's
 * `qgis` hint, and that the fixable/broken split survives. */

const DIAG: GeoEvent.QgisDiagnostics = {
  hint: "/somewhere/qgis",
  candidates: {},
  selected: {},
  // Deliberately unlike any path the copy itself names as an example: /opt/homebrew/bin/python3 here would let the
  // echo assertion below match the prose's own "system pythons" line and pass with the echo removed.
  interpreter: "/Users/someone/miniconda3/envs/gis/bin/python3.11",
  error: "ImportError: no module named osgeo",
} as GeoEvent.QgisDiagnostics

const MACHINE = path.join(Global.Path.config, "machine.json")

describe("QgisGuidance", () => {
  test("unconfigured teaches the file the kernel actually reads", () => {
    const text = QgisGuidance.render({ status: "unconfigured" })
    expect(text).toContain(MACHINE)
    expect(text).toContain('"qgis"')
    expect(text).toContain("https://qgis.org/download/")
    expect(text).toContain("DO NOT install QGIS yourself")
    expect(text).toContain("no restart needed")
    // geocode.json is a real file that still holds agent config, so naming it here sends the agent to edit
    // something the QGIS resolver never reads (docs/PATHS.md).
    expect(text).not.toContain("geocode.json")
    expect(text).not.toContain("qgis.python")
  })

  test("locate-and-configure states share the fixable body", () => {
    for (const status of [
      { status: "path-missing" as const, hint: "/gone/QGIS.app" },
      { status: "not-qgis" as const, hint: "found a Python, not QGIS" },
    ]) {
      const text = QgisGuidance.render(status)
      expect(text).toContain(status.hint!)
      expect(text).toContain(MACHINE)
      expect(text).toContain('"qgis"')
    }
  })

  test("config-error names the file and the parse message", () => {
    const text = QgisGuidance.render({ status: "config-error", file: "/cfg/machine.json", message: "bad token" })
    expect(text).toContain("/cfg/machine.json")
    expect(text).toContain("bad token")
  })

  test("broken installs say reinstall, with a distinct symptom each", () => {
    const states = ["gdal-missing", "proj-broken", "core-missing", "probe-timeout", "probe-failed"] as const
    const openings = new Set<string>()
    for (const status of states) {
      const text = QgisGuidance.render({ status, diagnostics: DIAG })
      expect(text).toContain("reinstall")
      expect(text).toContain("ImportError: no module named osgeo")
      expect(text).toContain(MACHINE)
      openings.add(text.split("\n")[0])
    }
    // The shared `broken()` body must not blur the five symptoms into one.
    expect(openings.size).toBe(states.length)
  })

  test("a broken install forbids the agent from installing anything itself", () => {
    // `broken()` advises a reinstall and is a branch `fixable()` never reaches, so the prohibition there does not
    // stop an agent from running the installer itself.
    for (const status of ["gdal-missing", "proj-broken", "core-missing"] as const) {
      const text = QgisGuidance.render({ status, diagnostics: DIAG })
      expect(text).toContain("DO NOT run any install")
      expect(text).toMatch(/ask the USER to reinstall/)
      expect(text).toContain("DO NOT write a wrapper")
      expect(text).toContain("repair bindings or plugins by hand")
    }
  })

  test("the macOS caveat that names the command an agent would reach for", () => {
    if (process.platform === "win32") return
    // Without it, the reinstall advice above is compatible with the cask build whose GDAL bindings are the classic
    // cause of gdal-missing on macOS, so the agent could recommend re-creating the fault it is standing in.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).toContain("Homebrew cask")
    expect(text).toContain("official .dmg")
    expect(text).toContain("no brew")
  })

  test("a broken install shows the path it is asking the agent to judge", () => {
    // `GeoTool.qgisHeader` renders only on `ready`, so on a broken install this is the sole place the path step 1
    // asks the agent to judge can appear at all.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).toContain(DIAG.interpreter!)
  })

  test("a ready environment the gate still refuses gets an answer, not silence", () => {
    // The gate needs ready AND processing AND catalog "ready" (§4.9); a refused shape `render` misses comes out as "",
    // and the tool prints its generic fallback instead.
    const building = QgisGuidance.render({ status: "ready", processing: true, catalog: "building" } as never)
    expect(building).toContain("Try again shortly")
    const noProcessing = QgisGuidance.render({ status: "ready", processing: false, catalog: "skipped" } as never)
    expect(noProcessing).toContain("Processing framework is not available")
    expect(noProcessing).toContain("reinstall")
    const failed = QgisGuidance.render({
      status: "ready",
      processing: true,
      catalog: "failed",
      catalogError: "dump exploded",
    } as never)
    expect(failed).toContain("dump exploded")
    expect(failed).toContain("reinstall")
  })

  test("a broken install is not promised a re-probe that does not exist", () => {
    // `config/index.ts` drops a block whose fingerprint is unchanged and nothing watches the install itself, so an
    // agent promised a re-probe recommends a reinstall, calls the tool again and reads back the same failure.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).not.toMatch(/install changes underneath/i)
    // Both routes, because either alone strands a reader: a reinstall that moves the path needs an edit, one that
    // lands on the same path needs a restart.
    expect(text).toMatch(/restarted/i)
    expect(text).toMatch(/different path/i)

    // In the configure branch the agent writes a value that differs, so saving does re-probe there.
    expect(QgisGuidance.render({ status: "unconfigured" })).toContain("re-probes automatically after save")
  })

  test("a skipped catalog answers even if it ever arrives without its cause", () => {
    // Built by hand: the kernel pairs `catalog: "skipped"` with `processing: false` (qgis/index.ts) by convention,
    // not by type.
    const orphan = QgisGuidance.render({ status: "ready", processing: true, catalog: "skipped" } as never)
    expect(orphan).not.toBe("")
    expect(orphan).toContain("Processing framework is not available")
  })

  test("the Windows locate step does not stop at the system drive", () => {
    // An agent handed C:-only probes concludes "not installed" and sends the user to download software they have.
    // `process.platform` is swapped rather than the test skipped off Windows, or no machine running this suite
    // would check this branch.
    const real = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true })
      const text = QgisGuidance.render({ status: "unconfigured" })
      expect(text).toContain("Program Files")
      expect(text).toMatch(/not conclude it is missing/i)
      expect(text).toMatch(/D:/)
    } finally {
      Object.defineProperty(process, "platform", real)
    }
  })

  test("a fully ready environment has nothing to say", () => {
    expect(QgisGuidance.render({ status: "ready", processing: true, catalog: "ready" } as never)).toBe("")
  })
})
