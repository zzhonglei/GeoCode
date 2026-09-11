import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeeDeps } from "@/geo/gee/deps"
import { GeeGuidance } from "@/geo/gee/guidance"

/* The GEE group's one voice (docs/GEOKERNEL.md §5.11): every not-ready state answers, on the step the probe
 * stopped at, naming who performs it and the file the kernel actually reads. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-guidance-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** Deliberately unlike the miniforge paths the copy names as examples, which an echo assertion would match instead. */
const PYTHON = path.join(root, "envs", "demo", "bin", "python3")
fs.mkdirSync(path.dirname(PYTHON), { recursive: true })
fs.writeFileSync(PYTHON, "")

/** A second environment, conda-shaped: `conda-meta/` beside the bin directory. */
const CONDA_PYTHON = path.join(root, "conda-env", "bin", "python3")
fs.mkdirSync(path.dirname(CONDA_PYTHON), { recursive: true })
fs.writeFileSync(CONDA_PYTHON, "")
fs.mkdirSync(path.join(root, "conda-env", "conda-meta"), { recursive: true })

const MACHINE = path.join(Global.Path.config, "machine.json")

const READY = { status: "ready", python: PYTHON, project: "ee-demo" } as const

/** A setup-layer status, composed the way the module composes one. */
const setup = (state: GeoEvent.GeeSetup): GeoEvent.GeeStatus => ({
  facing: "setup",
  setup: state,
  network: { status: "idle" },
  runtime: { status: "unknown" },
})

const network = (state: GeoEvent.GeeNetwork): GeoEvent.GeeStatus => ({
  facing: "network",
  setup: READY,
  network: state,
  runtime: { status: "unknown" },
})

const remote = (state: GeoEvent.GeeRuntime): GeoEvent.GeeStatus => ({
  facing: "runtime",
  setup: READY,
  network: { status: "reachable", route: "direct" },
  runtime: state,
})

/** Every setup state but `ready`, which is to say every one that owes the user an answer. */
const ALL_SETUP: GeoEvent.GeeSetup[] = [
  { status: "unconfigured" },
  { status: "config-error", file: "/cfg/machine.json", message: "unexpected token" },
  { status: "python-missing", python: PYTHON },
  { status: "checking" },
  { status: "packages-missing", python: PYTHON, missing: ["geemap"] },
  { status: "packages-broken", python: PYTHON, pkg: "geopandas", error: "ImportError: DLL load failed" },
  { status: "credentials-missing", python: PYTHON },
  { status: "project-missing" },
  { status: "probe-timeout" },
  { status: "probe-failed", error: "ModuleNotFoundError: no module named 'ee'" },
]

describe("GeeGuidance", () => {
  test("no state is left without an answer", () => {
    // Spelled out rather than derived: an added setup state breaks `setupGuidance`'s switch, but nothing would put
    // it in ALL_SETUP, and the loop below would keep passing without ever rendering it.
    expect(ALL_SETUP.map((state) => state.status).sort()).toEqual([
      "checking",
      "config-error",
      "credentials-missing",
      "packages-broken",
      "packages-missing",
      "probe-failed",
      "probe-timeout",
      "project-missing",
      "python-missing",
      "unconfigured",
    ])

    // An empty string is a tool answering a real problem with nothing.
    for (const state of ALL_SETUP) expect(GeeGuidance.render(setup(state)).length).toBeGreaterThan(0)
    for (const state of [{ status: "unreachable" } as const, { status: "checking" } as const])
      expect(GeeGuidance.render(network(state)).length).toBeGreaterThan(0)
    for (const state of [
      { status: "unknown" } as const,
      { status: "checking" } as const,
      { status: "failed", reason: "unknown", message: "boom" } as const,
    ])
      expect(GeeGuidance.render(remote(state)).length).toBeGreaterThan(0)
  })

  test("the four steps are walked one at a time, in the probe's order", () => {
    // The step a state belongs to has to match where §5.3's short-circuit actually stops.
    const steps: [GeoEvent.GeeSetup, number][] = [
      [{ status: "unconfigured" }, 1],
      [{ status: "python-missing", python: PYTHON }, 1],
      [{ status: "packages-missing", python: PYTHON, missing: ["geemap"] }, 2],
      [{ status: "credentials-missing", python: PYTHON }, 3],
      [{ status: "project-missing" }, 4],
    ]
    for (const [state, step] of steps) {
      const text = GeeGuidance.render(setup(state))
      expect(text).toContain(`Step ${step} of 4`)
      expect(text.match(/^ {2}done {2}\d\./gm) ?? []).toHaveLength(step - 1)
      expect(text.match(/^ {2}→ {5}\d\./gm) ?? []).toHaveLength(1)
    }
  })

  test("the file taught is the one the kernel reads", () => {
    // geocode.json holds the kernel and agent settings; a gee block there is read by nothing (docs/PATHS.md §3.2).
    for (const state of ALL_SETUP) {
      expect(GeeGuidance.render(setup(state))).not.toContain("geocode.json")
    }
    for (const name of ["unconfigured", "python-missing", "project-missing"] as const) {
      const state = ALL_SETUP.find((entry) => entry.status === name)!
      expect(GeeGuidance.render(setup(state))).toContain(MACHINE)
    }
  })

  // Step 2 — the install --------------------------------------------------------

  test("packages install one at a time, through the configured interpreter", () => {
    const missing = ["earthengine-api", "geemap", "geedim"]
    const text = GeeGuidance.render(setup({ status: "packages-missing", python: PYTHON, missing }))

    const commands = text.match(/-m pip install \S+/g) ?? []
    expect(commands).toHaveLength(missing.length)
    for (const pkg of missing) {
      // The quoted interpreter immediately before `-m pip install` is what makes a bare `pip install`, or one off
      // PATH, fail this.
      expect(text).toMatch(
        new RegExp(`["']${PYTHON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'] -m pip install ${pkg}(\\s|$)`),
      )
      expect(text).toContain(GeeDeps.byPackage(pkg)!.role)
    }
    expect(text).toMatch(/Offer to run them/)
    expect(text).not.toMatch(/Take initiative/)
  })

  test("an empty missing list still names something to install", () => {
    // The schema allows the empty list the probe never sends, and an empty install command reads as "nothing to do".
    const text = GeeGuidance.render(setup({ status: "packages-missing", python: PYTHON, missing: [] }))
    for (const pkg of GeeDeps.PACKAGES) expect(text).toContain(`-m pip install ${pkg}`)
  })

  test("conda-forge is offered only when both signals hold", () => {
    const both = GeeGuidance.render(setup({ status: "packages-missing", python: CONDA_PYTHON, missing: ["geopandas"] }))
    expect(both).toContain("conda install -c conda-forge geopandas")
    expect(both).toContain("ABI-mismatch")

    // conda environment, but nothing GDAL-bound is missing.
    const noGeopandas = GeeGuidance.render(
      setup({ status: "packages-missing", python: CONDA_PYTHON, missing: ["geemap"] }),
    )
    expect(noGeopandas).not.toContain("conda-forge")

    // geopandas missing, but this is not a conda environment.
    const noConda = GeeGuidance.render(setup({ status: "packages-missing", python: PYTHON, missing: ["geopandas"] }))
    expect(noConda).not.toContain("conda-forge")
    expect(noConda).toContain("-m pip install geopandas")
  })

  test("an installed-but-broken package is never called missing", () => {
    const text = GeeGuidance.render(
      setup({
        status: "packages-broken",
        python: PYTHON,
        pkg: "geopandas",
        error: "ImportError: DLL load failed while importing _fiona",
      }),
    )
    expect(text).toContain("DLL load failed while importing _fiona")
    expect(text).toMatch(/Installing it again will not fix this/)
    expect(text).toMatch(/Do NOT tell the user the package is missing/)
    expect(text).toContain("--force-reinstall")
    // Still step 2: the chain stopped in the same place, for a different reason.
    expect(text).toContain("Step 2 of 4")

    const inConda = GeeGuidance.render(
      setup({ status: "packages-broken", python: CONDA_PYTHON, pkg: "geopandas", error: "boom" }),
    )
    expect(inConda).toContain("conda install -c conda-forge --force-reinstall geopandas")
    expect(text).not.toContain("conda-forge")
  })

  test("the conda alternative is one solve, not one command per package", () => {
    // conda solves the whole environment per invocation, so the split that the pip lines beside it need is wrong here.
    const text = GeeGuidance.render(
      setup({ status: "packages-missing", python: CONDA_PYTHON, missing: ["geopandas", "geemap"] }),
    )
    expect(text).toContain("conda install -c conda-forge geopandas geemap")
    expect(text.match(/conda install/g) ?? []).toHaveLength(1)
    expect(text.match(/-m pip install \S+/g) ?? []).toHaveLength(2)
  })

  test("a rejected project is looked up in both places it can exist", () => {
    // A project created in the Cloud console and never opened in the editor is not shown at the top of the editor.
    // Scoped to the attributed fix, since the closing paragraph names the Cloud console too and would answer for it.
    const text = GeeGuidance.render(remote({ status: "failed", reason: "project-invalid", message: "no such project" }))
    const fix = text.split("Most likely fix:")[1]?.split("\n\n")[0] ?? ""
    expect(fix).toMatch(/Earth Engine editor/)
    expect(fix).toMatch(/Google Cloud console/)
  })

  test("the remote refusal names the file it tells the agent to edit", () => {
    // It tells the agent to correct gee.project in machine.json, and a bare filename leaves it guessing where.
    const text = GeeGuidance.render(remote({ status: "failed", reason: "project-invalid", message: "no such project" }))
    expect(text).toContain(MACHINE)
  })

  // Step 3 — the sign-in --------------------------------------------------------

  test("the authentication command is located from the interpreter", () => {
    const text = GeeGuidance.render(setup({ status: "credentials-missing", python: PYTHON }))
    expect(text).toContain(path.join(path.dirname(PYTHON), "earthengine"))

    // A second environment, since a path written down somewhere would satisfy the assertion above just as well.
    const other = GeeGuidance.render(setup({ status: "credentials-missing", python: CONDA_PYTHON }))
    expect(other).toContain(path.join(path.dirname(CONDA_PYTHON), "earthengine"))
    expect(other).not.toContain(path.dirname(PYTHON))
  })

  test("the sign-in waits for the user twice", () => {
    // Ask, wait, run, wait again — the command opens a browser and waits for a person.
    const text = GeeGuidance.render(setup({ status: "credentials-missing", python: PYTHON }))
    expect(text).toMatch(/Do NOT run the command until/)
    expect(text).toContain("have their Google account ready")
    expect(text).toContain("tell me it's done")
    // And never a claim that the app itself opens that browser (§5.11 硬边界 1).
    expect(text).not.toMatch(/open (a|the) browser for you/i)
  })

  // Step 4 — the project --------------------------------------------------------

  test("the project is the user's to give, and never invented", () => {
    const text = GeeGuidance.render(setup({ status: "project-missing" }))
    expect(text).toContain("NEVER invent one")
    expect(text).toContain("https://code.earthengine.google.com")
    expect(text).toContain('"gee"')
    expect(text).toContain("Step 4 of 4")
  })

  // The probe itself ------------------------------------------------------------

  test("a failed probe is diagnosed before anything is changed", () => {
    const failed = GeeGuidance.render(setup({ status: "probe-failed", error: "Segmentation fault" }))
    expect(failed).toContain("Segmentation fault")
    expect(failed).toContain("Do NOT rewrite the configuration on a guess")
    expect(failed).toContain("starts no network connection")
    const timeout = GeeGuidance.render(setup({ status: "probe-timeout" }))
    expect(timeout).toContain("time limit")
    // Two states through one shared body, which must not blur them into one symptom.
    expect(failed.split("\n")[0]).not.toBe(timeout.split("\n")[0])
  })

  // The network layer -----------------------------------------------------------

  test("a network failure forbids every local repair", () => {
    // All four local steps passed to get here, so every repair an agent would reach for damages a working part.
    const text = GeeGuidance.render(network({ status: "unreachable" }))
    expect(text).toContain("do NOT reinstall Python packages")
    expect(text).toContain("do NOT edit")
    expect(text).toContain("do NOT ask the user to sign in again")
    expect(text).toContain("All four steps")
    // And no repair command at all: a prohibition beside a copy-pasteable install line is worse than neither.
    expect(text).not.toContain("pip install")
    expect(text).not.toContain("authenticate")
    expect(text).toContain(PYTHON)
    expect(text).toContain("ee-demo")
  })

  test("the network branch says the network is the problem, and nothing about proxies", () => {
    // An agent cannot reconfigure the user's proxy software, so the vocabulary only invites a diagnosis it cannot
    // make (§5.11 硬边界 3).
    const text = GeeGuidance.render(network({ status: "unreachable" }))
    // The temp directory is echoed in the interpreter path, and its random name can spell any of these.
    expect(text.replaceAll(root, "")).not.toMatch(/proxy|VPN|SOCKS|tunnel/i)
    expect(text).toMatch(/network connection is what cannot currently\s+reach Earth Engine/)
    expect(text).toContain("All four steps")
    expect(text).toMatch(/leave the connection itself to them/)
  })

  test("every state that installs anything asks permission first", () => {
    // On all three states that change an environment, since the response templates only demonstrate asking.
    const installers: GeoEvent.GeeSetup[] = [
      { status: "unconfigured" },
      { status: "packages-missing", python: PYTHON, missing: ["geemap"] },
      { status: "packages-broken", python: PYTHON, pkg: "geopandas", error: "boom" },
    ]
    for (const state of installers) {
      const text = GeeGuidance.render(setup(state))
      expect(text).toMatch(/ALWAYS get the user's agreement before changing their Python environment/)
      expect(text).toMatch(/Ask, and wait for\s+the answer/)
    }
  })

  test("using conda is fine; installing it is not ours to do", () => {
    // The copy offers a conda command; putting conda itself on the user's machine is not the agent's to do.
    const text = GeeGuidance.render(setup({ status: "unconfigured" }))
    expect(text).toContain("conda create -n <name> python=3.12 -y")
    expect(text).toMatch(/Do NOT install conda or miniforge yourself/)
    expect(text).toMatch(/that is theirs to install/)
  })

  test("writing the configuration names the tool that edits in place", () => {
    // machine.json holds the qgis and gdal blocks too, and "write gee.python to the file" invites a whole-file
    // redirect that takes them with it.
    const writers: GeoEvent.GeeSetup[] = [
      { status: "unconfigured" },
      { status: "python-missing", python: PYTHON },
      { status: "project-missing" },
    ]
    for (const state of writers) {
      const text = GeeGuidance.render(setup(state))
      expect(text).toMatch(/Edit tool/)
      expect(text).toMatch(/in place/)
    }
    expect(GeeGuidance.render(setup({ status: "unconfigured" }))).toMatch(/QGIS and GDAL/)
  })

  // The remote layer ------------------------------------------------------------

  test("each attribution leads somewhere different", () => {
    // Five reasons collapsing onto one paragraph would leave the attribution as decoration.
    const reasons: GeoEvent.GeeRejection[] = [
      "api-disabled",
      "permission-denied",
      "credentials-expired",
      "project-invalid",
      "unknown",
    ]
    const fixes = new Set<string>()
    for (const reason of reasons) {
      const text = GeeGuidance.render(remote({ status: "failed", reason, message: "Google said no" }))
      expect(text).toContain(reason)
      // Google's own words beside our reading of them, which can be wrong (§5.5 归因).
      expect(text).toContain("Google said no")
      const fix = text.split("Most likely fix:")[1]?.split("\n\n")[0] ?? ""
      expect(fix.length).toBeGreaterThan(0)
      fixes.add(fix)
    }
    expect(fixes.size).toBe(reasons.length)
  })

  test("the agent is told to diagnose, not to recite", () => {
    // The keyword map is what turns four listed causes into one chosen one.
    const text = GeeGuidance.render(remote({ status: "failed", reason: "unknown", message: "?" }))
    expect(text).toContain("SINGLE most likely")
    expect(text).toContain("Do not list all four")
    expect(text).toContain("not registered")
    expect(text).toContain("unauthorized")
    expect(text).toContain("not enabled")
  })

  // The routing itself ----------------------------------------------------------

  test("facing decides which layer speaks", () => {
    // A hand-built contradiction, since `compose` cannot produce one: a network story told over a broken local
    // setup is the misattribution the priority exists to prevent (§5.6).
    const contradiction: GeoEvent.GeeStatus = {
      facing: "network",
      setup: { status: "packages-missing", python: PYTHON, missing: ["geemap"] },
      network: { status: "unreachable" },
      runtime: { status: "unknown" },
    }
    const text = GeeGuidance.render(contradiction)
    expect(text).toContain("Step 2 of 4")
    expect(text).not.toContain("cannot be reached over the network")
  })

  test("a usable Earth Engine has nothing to say", () => {
    expect(GeeGuidance.render(remote({ status: "valid", route: "direct" }))).toBe("")
  })
})
