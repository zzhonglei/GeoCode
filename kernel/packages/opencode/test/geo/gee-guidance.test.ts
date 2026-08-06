import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeeDeps } from "@/geo/gee/deps"
import { GeeGuidance } from "@/geo/gee/guidance"

/* The GEE group's one voice (docs/GEOKERNEL.md §5.11).
 *
 * What these guard is not phrasing but the handful of sentences that were
 * learned by getting burned, and the structure that keeps them findable:
 *
 * - the chain is walked ONE step at a time, and every state says which step
 * - each step says WHO performs it, which is the difference between an agent
 *   that helps and one that installs into the wrong environment, invents a
 *   project id, or opens a sign-in nobody is watching
 * - the network layer FORBIDS the local repairs an agent would otherwise
 *   reach for — every one of them damages something already correct
 * - the file taught is machine.json, the one the kernel reads
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-gee-guidance-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/**
 * A plain interpreter, deliberately unlike the paths the static copy names as
 * examples: with something miniforge-shaped here, an assertion that the
 * configured path was echoed would match the example prose instead and pass
 * with the echo removed. (The QGIS sibling learned this the hard way.)
 */
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

/** Every setup state the probe can publish, so no branch goes unwritten. */
const ALL_SETUP: GeoEvent.GeeSetup[] = [
  { status: "unconfigured" },
  { status: "config-error", file: "/cfg/machine.json", message: "unexpected token" },
  { status: "python-missing", python: PYTHON },
  { status: "checking" },
  { status: "packages-missing", python: PYTHON, missing: ["geemap"] },
  { status: "credentials-missing", python: PYTHON },
  { status: "project-missing" },
  { status: "probe-timeout" },
  { status: "probe-failed", error: "ModuleNotFoundError: no module named 'ee'" },
]

describe("GeeGuidance", () => {
  test("no state is left without an answer", () => {
    // Spelled out rather than derived from ALL_SETUP: a new setup state stops
    // `setupGuidance`'s switch from compiling, so the copy always gets written
    // — but nothing would force it into the list below, and the coverage check
    // would keep passing while never rendering it. Changing this literal is
    // the deliberate act.
    expect(ALL_SETUP.map((state) => state.status).sort()).toEqual([
      "checking",
      "config-error",
      "credentials-missing",
      "packages-missing",
      "probe-failed",
      "probe-timeout",
      "project-missing",
      "python-missing",
      "unconfigured",
    ])

    // An empty string here is a tool that returns a blank refusal — the state
    // is real, the user gets nothing.
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
    // Which step a state belongs to is the whole of §5.11's step-by-step
    // model, and it has to match where §5.3's short-circuit actually stops.
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
      // The whole ladder is shown, and everything before the current rung is
      // marked done — someone on step 3 should see how far they have come, and
      // someone on step 1 how far it goes.
      expect(text.match(/^ {2}done {2}\d\./gm) ?? []).toHaveLength(step - 1)
      expect(text.match(/^ {2}→ {5}\d\./gm) ?? []).toHaveLength(1)
    }
  })

  test("the file taught is the one the kernel reads", () => {
    // The old build's copy taught geocode.json. Porting the sentences without
    // moving the target sends the agent to a file nobody reads (PATHS §5).
    for (const state of ALL_SETUP) {
      expect(GeeGuidance.render(setup(state))).not.toContain("geocode.json")
    }
    // Named, not indexed: an index silently points at a different state the
    // moment the list above gains an entry, and the assertion keeps passing
    // while testing something else.
    for (const name of ["unconfigured", "python-missing", "project-missing"] as const) {
      const state = ALL_SETUP.find((entry) => entry.status === name)!
      expect(GeeGuidance.render(setup(state))).toContain(MACHINE)
    }
  })

  // Step 2 — the install --------------------------------------------------------

  test("packages install one at a time, through the configured interpreter", () => {
    // Both disciplines of §5.11 in one place. One command per package, because
    // each takes minutes and a merged command is indistinguishable from a
    // hang; and through THIS interpreter, because a package manager found on
    // PATH may belong to a different environment, in which case the install
    // succeeds and the state does not change.
    const missing = ["earthengine-api", "geemap", "geedim"]
    const text = GeeGuidance.render(setup({ status: "packages-missing", python: PYTHON, missing }))

    // One command per package: as many install lines as there are gaps.
    const commands = text.match(/-m pip install \S+/g) ?? []
    expect(commands).toHaveLength(missing.length)
    for (const pkg of missing) {
      // And each one goes THROUGH the configured interpreter — the quoted path
      // immediately before `-m pip install` is what makes this assertion able
      // to fail on a bare `pip install` or a `python -m pip` off PATH.
      expect(text).toMatch(
        new RegExp(`["']${PYTHON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'] -m pip install ${pkg}(\\s|$)`),
      )
      // The role line, so the user learns what they are installing and why.
      expect(text).toContain(GeeDeps.byPackage(pkg)!.role)
    }
    expect(text).toContain("Take initiative")
  })

  test("an empty missing list still names something to install", () => {
    // The probe can report a gap without naming it. An empty command is worse
    // than an over-broad one: it reads as "nothing to do" in a blocked state.
    const text = GeeGuidance.render(setup({ status: "packages-missing", python: PYTHON, missing: [] }))
    for (const pkg of GeeDeps.PACKAGES) expect(text).toContain(`-m pip install ${pkg}`)
  })

  test("conda-forge is offered only when both signals hold", () => {
    // geopandas is the one dependency here pulling GDAL-bound extensions
    // (fiona, pyogrio), where a pip wheel can ABI-mismatch what conda already
    // installed. Offering conda to a venv user is noise; offering it for
    // pure-Python packages is caution with no cause. Both signals, or neither.
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
    // And the always-runnable command is still there in every case.
    expect(noConda).toContain("-m pip install geopandas")
  })

  // Step 3 — the sign-in --------------------------------------------------------

  test("the authentication command is located from the interpreter", () => {
    // It ships with the client library, so it lives wherever that environment
    // puts it — never a fixed path, and never assumed to be on PATH: the
    // configured interpreter may belong to an environment that is not active.
    const text = GeeGuidance.render(setup({ status: "credentials-missing", python: PYTHON }))
    expect(text).toContain(path.join(path.dirname(PYTHON), "earthengine"))

    // A different environment must produce a different command — otherwise the
    // path is written down somewhere rather than derived.
    const other = GeeGuidance.render(setup({ status: "credentials-missing", python: CONDA_PYTHON }))
    expect(other).toContain(path.join(path.dirname(CONDA_PYTHON), "earthengine"))
    expect(other).not.toContain(path.dirname(PYTHON))
  })

  test("the sign-in waits for the user twice", () => {
    // The one step the agent cannot finish: the command opens a browser and
    // waits for a person. Run before the user is ready it is a window nobody
    // is watching and a command that times out. Ask, wait, run, wait again.
    const text = GeeGuidance.render(setup({ status: "credentials-missing", python: PYTHON }))
    expect(text).toMatch(/Do NOT run the command until/)
    expect(text).toContain("have their Google account ready")
    expect(text).toContain("tell me it's done")
    // And it never claims the app itself can do the sign-in (§5.11 硬边界 1).
    expect(text).not.toMatch(/open (a|the) browser for you/i)
  })

  // Step 4 — the project --------------------------------------------------------

  test("the project is the user's to give, and never invented", () => {
    // A real resource under their account. A guessed value is rejected by
    // Google with a message that reads like a permissions problem, which sends
    // the next diagnosis in exactly the wrong direction.
    const text = GeeGuidance.render(setup({ status: "project-missing" }))
    expect(text).toContain("NEVER invent one")
    expect(text).toContain("https://code.earthengine.google.com")
    expect(text).toContain('"gee"')
    expect(text).toContain("Step 4 of 4")
  })

  // The probe itself ------------------------------------------------------------

  test("a failed probe is diagnosed before anything is changed", () => {
    // Not a rung on the chain: the check did not get to answer. The trap is an
    // agent that "fixes" it by rewriting configuration or reinstalling
    // packages, neither of which it has evidence for.
    const failed = GeeGuidance.render(setup({ status: "probe-failed", error: "Segmentation fault" }))
    expect(failed).toContain("Segmentation fault")
    expect(failed).toContain("Do NOT rewrite the configuration on a guess")
    expect(failed).toContain("starts no network connection")
    const timeout = GeeGuidance.render(setup({ status: "probe-timeout" }))
    expect(timeout).toContain("time limit")
    // Two states, two distinct diagnoses — a shared body must not blur them.
    expect(failed.split("\n")[0]).not.toBe(timeout.split("\n")[0])
  })

  // The network layer -----------------------------------------------------------

  test("a network failure forbids every local repair", () => {
    // §5.11 硬边界 3, and the substance of this branch. Everything local is
    // verified by the time anyone reads it, so each repair an agent would
    // reach for damages something already correct: reinstalling churns a
    // working environment, re-authenticating cannot complete over a dead link,
    // and editing the configuration edits the part that is right.
    const text = GeeGuidance.render(network({ status: "unreachable" }))
    expect(text).toContain("do NOT reinstall Python packages")
    expect(text).toContain("do NOT edit")
    expect(text).toContain("do NOT ask the user to sign in again")
    expect(text).toContain("All four steps")
    // No repair command may appear here at all — the prohibition and a
    // copy-pasteable install line in the same text is worse than neither.
    expect(text).not.toContain("pip install")
    expect(text).not.toContain("authenticate")
    // It still names the environment being blocked, so the reader knows the
    // setup it is talking about.
    expect(text).toContain(PYTHON)
    expect(text).toContain("ee-demo")
  })

  test("the network branch says the network is the problem, and nothing about proxies", () => {
    /* A product decision, pinned here because it is the kind that drifts back.
     *
     * The old build's copy described the route search — which sources were
     * tried, and that switching a proxy to HTTP or mixed mode is often the fix.
     * This build says none of it, on purpose: an agent cannot reconfigure the
     * user's proxy software, so the vocabulary buys nothing and invites a
     * diagnosis it is in no position to make. The connection is the user's.
     *
     * (The sentence that started this was worse than useless — it claimed the
     * system proxy had been searched, which this build does not do. Copy for
     * the model is allowed to be thin. It is not allowed to be wrong.)
     */
    const text = GeeGuidance.render(network({ status: "unreachable" }))
    expect(text).not.toMatch(/proxy|VPN|SOCKS|tunnel/i)
    // What it does say: the network is at fault, and the local setup is not.
    expect(text).toMatch(/network connection is what cannot currently\s+reach Earth Engine/)
    expect(text).toContain("All four steps")
    expect(text).toMatch(/leave the connection itself to them/)
  })

  test("writing the configuration names the tool that edits in place", () => {
    // machine.json holds the qgis, gee and gdal blocks together. "Write
    // gee.python to the file" invites a heredoc or a redirect that replaces the
    // whole file, taking the user's QGIS configuration with it. The old build
    // named the Edit tool at all three of these points for that reason.
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
    // And the reason travels with the instruction on the two that add a field
    // to a file that already has other blocks in it.
    expect(GeeGuidance.render(setup({ status: "unconfigured" }))).toMatch(/QGIS and GDAL/)
  })

  // The remote layer ------------------------------------------------------------

  test("each attribution leads somewhere different", () => {
    // The attribution exists to pick ONE fix. Five reasons collapsing onto one
    // paragraph would make it decoration.
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
      // Google's own words travel verbatim beside our reading of them, because
      // our reading can be wrong (§5.5 归因).
      expect(text).toContain("Google said no")
      const fix = text.split("Most likely fix:")[1]?.split("\n\n")[0] ?? ""
      expect(fix.length).toBeGreaterThan(0)
      fixes.add(fix)
    }
    expect(fixes.size).toBe(reasons.length)
  })

  test("the agent is told to diagnose, not to recite", () => {
    // Four causes with a keyword map, and an instruction to pick one. Dumping
    // all four at a user is the failure this sentence was written against.
    const text = GeeGuidance.render(remote({ status: "failed", reason: "unknown", message: "?" }))
    expect(text).toContain("SINGLE most likely")
    expect(text).toContain("Do not list all four")
    expect(text).toContain("not registered")
    expect(text).toContain("unauthorized")
    expect(text).toContain("not enabled")
  })

  // The routing itself ----------------------------------------------------------

  test("facing decides which layer speaks", () => {
    // The short-circuit is computed once, in compose (§5.6). Re-deciding it
    // here would implement the rule twice in two places free to disagree — and
    // a network story told over a broken local setup is the exact
    // misattribution the priority exists to prevent.
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
