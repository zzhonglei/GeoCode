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
  // The path the guidance asks the agent to judge. It travels on every broken
  // state and is the only place it can surface — the environment header is
  // silent whenever the status is not `ready`.
  // Deliberately unlike any path the static copy names as an example: with
  // /opt/homebrew/bin/python3 here the assertion below matched the prose's own
  // "system pythons look like this" line and passed with the echo removed.
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

  test("a broken install forbids the agent from installing anything itself", () => {
    // The guardrail belongs in THIS branch, not only in the configure one. This
    // branch's advice ends in "reinstall QGIS", and an agent told to recommend a
    // reinstall is one step from performing it; the configure branch, where the
    // prohibition used to live alone, is a path a broken install never reaches.
    //
    // The user's standing constraint is that installing or reinstalling QGIS is
    // never the agent's to do — it is the one repair that needs a human.
    for (const status of ["gdal-missing", "proj-broken", "core-missing"] as const) {
      const text = QgisGuidance.render({ status, diagnostics: DIAG })
      expect(text).toContain("DO NOT run any install")
      expect(text).toMatch(/ask the USER to reinstall/)
      // And the fix must stay out of the agent's hands in the other direction
      // too: hand-repairing bindings, and wrapper scripts.
      expect(text).toContain("DO NOT write a wrapper")
      expect(text).toContain("repair bindings or plugins by hand")
    }
  })

  test("the macOS caveat that names the command an agent would reach for", () => {
    if (process.platform === "win32") return
    // gdal-missing is the state a macOS user arrives in most often, and the
    // Homebrew cask build's broken GDAL bindings are its classic cause — so
    // `brew install --cask qgis` is precisely the command that reproduces the
    // fault the agent is standing in. Losing this sentence and losing the
    // install prohibition compound each other, which is how they were lost.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).toContain("Homebrew cask")
    expect(text).toContain("official .dmg")
    expect(text).toContain("no brew")
  })

  test("a broken install shows the path it is asking the agent to judge", () => {
    // Step 1 asks whether the hint points at a real QGIS install. A reader
    // cannot judge a path it has not been shown, and in these states the
    // environment header renders nothing — so this is the only place it can
    // appear.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).toContain(DIAG.interpreter!)
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

  test("a broken install is not promised a re-probe that does not exist", () => {
    // `config/index.ts` drops a block whose fingerprint is unchanged, so saving
    // machine.json without editing it runs nothing — and after a reinstall the
    // hint usually IS unchanged. The earlier wording promised a re-probe "after
    // the install changes underneath it"; nothing watches the install. An agent
    // believing it tells the user to reinstall, calls the tool again, and reads
    // back the identical failure, having spent the user's time for nothing.
    const text = QgisGuidance.render({ status: "gdal-missing", diagnostics: DIAG })
    expect(text).not.toMatch(/install changes underneath/i)
    // Both routes, because either alone strands a reader: a reinstall that moves
    // the path needs an edit, one that does not needs a restart.
    expect(text).toMatch(/restarted/i)
    expect(text).toMatch(/different path/i)

    // The contrast IS the finding. Saving does re-probe in the configure branch,
    // because there the agent is writing a value that differs — one sentence,
    // true in one branch and false in the other, is how it survived.
    expect(QgisGuidance.render({ status: "unconfigured" })).toContain("re-probes automatically after save")
  })

  test("a skipped catalog answers even if it ever arrives without its cause", () => {
    // The kernel only commits `catalog: "skipped"` alongside `processing: false`
    // (qgis/index.ts), which is why the branch that tested it alone sat below
    // the Processing check and could never run. That pairing is a convention,
    // not a type, and the tool layer keeps the two apart (tool/geo-tool.ts) — so
    // the orphan shape is built here on purpose. Silence is the one answer this
    // state must never get.
    const orphan = QgisGuidance.render({ status: "ready", processing: true, catalog: "skipped" } as never)
    expect(orphan).not.toBe("")
    expect(orphan).toContain("Processing framework is not available")
  })

  test("the Windows locate step does not stop at the system drive", () => {
    // A second drive is ordinary on Windows, and `where qgis` only finds an
    // install the installer put on PATH. An agent handed C:-only probes
    // concludes "not installed" and sends the user to download software they
    // already have.
    //
    // The platform is swapped rather than the test skipped off Windows: this
    // branch has never run on real hardware (GEOKERNEL §11.1), so a guard here
    // would mean nothing checks it at all, on any machine anyone owns.
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
