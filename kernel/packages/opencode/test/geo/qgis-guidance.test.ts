import { describe, expect, test } from "bun:test"
import * as path from "path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { QgisGuidance } from "../../src/geo/qgis/guidance"

/* The QGIS group's one voice (GEOKERNEL §8.6). What these guard:
 *
 * - The guidance teaches machine.json's `qgis` hint — the file the kernel
 *   actually reads. The old copy taught geocode.json's `qgis.python`; porting
 *   it without moving the target would send the Agent to a file nobody reads,
 *   so the target is pinned here.
 * - The fixable/broken split survives: locate-and-configure states carry the
 *   agent's step list, broken-install states say reinstall and never suggest
 *   hand-repair.
 */

const DIAG: GeoEvent.QgisDiagnostics = {
  hint: "/somewhere/qgis",
  candidates: {},
  selected: {},
  error: "ImportError: no module named osgeo",
} as GeoEvent.QgisDiagnostics

const MACHINE = path.join(Global.Path.config, "machine.json")

describe("QgisGuidance", () => {
  test("unconfigured teaches the file the kernel actually reads", () => {
    const text = QgisGuidance.render({ status: "unconfigured" })
    expect(text).toContain(MACHINE)
    expect(text).toContain('"qgis"')
    expect(text).toContain("https://qgis.org/download/")
    // The three prohibitions that keep an agent from "helping" destructively.
    expect(text).toContain("DO NOT install QGIS yourself")
    expect(text).toContain("no restart needed")
    // The old target must never come back.
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
    // Five states, five distinct diagnoses — a shared body must not blur them.
    expect(openings.size).toBe(states.length)
  })

  test("a ready environment the gate still refuses gets an answer, not silence", () => {
    // The gate needs ready AND processing AND catalog "ready" (§4.9); render
    // must cover the three ready-but-refused shapes or the tool returns an
    // empty output. The Processing pair was in the old version's broken
    // family from the start.
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

  test("a fully ready environment has nothing to say", () => {
    expect(QgisGuidance.render({ status: "ready", processing: true, catalog: "ready" } as never)).toBe("")
  })
})
