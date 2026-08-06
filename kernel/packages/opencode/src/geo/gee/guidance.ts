import { existsSync } from "node:fs"
import * as path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeeDeps } from "./deps"

/* --- GeoCode: the guidance shown when Earth Engine is not ready
 * (docs/GEOKERNEL.md §5.11; the GEE sibling of qgis/guidance.ts).
 *
 * Entered through `facing`, which has already short-circuited the three facts
 * (§5.6). Deciding the priority again here would implement that rule twice, in
 * two places free to disagree — and the whole point of the short-circuit is
 * that the user faces exactly one problem at a time.
 *
 * Setup is a CHAIN of four steps, which is what makes this file long: the user
 * is walked from "no Python at all" to "authorized" one rung at a time, and
 * every rung has to say WHO performs it (§5.11 行动归属三分):
 *
 *   Agent alone           unconfigured, python-missing, packages-missing
 *   Agent guides,
 *     the user performs   credentials-missing — a browser sign-in
 *   The user alone        project-missing — only they know their project
 *
 * Ported from the old build's six formatters. Its `gee.python` / `gee.project`
 * field names survive verbatim; only the FILE moved, from `geocode.json` to
 * `machine.json`. So unlike the QGIS port — where a five-shape location hint
 * replaced an interpreter path and the copy had to be rewritten — this one is
 * a move, and the sentences are the old ones (docs/PATHS.md §5). --- */

const machineJson = () => path.join(Global.Path.config, "machine.json")

/** Quote a path for the local shell — single quotes on Unix, double on Windows. */
function quote(target: string): string {
  return process.platform === "win32" ? `"${target}"` : `'${target}'`
}

/**
 * Whether the configured interpreter belongs to a conda environment.
 *
 * Decided by the presence of `conda-meta/`, which conda creates in every
 * environment it makes. A structural signal, and deliberately NOT a substring
 * match on names like "miniconda" or "miniforge": those are directory names,
 * and a directory can be renamed.
 *
 *   macOS/Linux: <env>/bin/python  — the environment root is two levels up
 *   Windows:     <env>/python.exe  — one level up
 */
function isConda(python: string): boolean {
  const root = process.platform === "win32" ? path.dirname(python) : path.dirname(path.dirname(python))
  return existsSync(path.join(root, "conda-meta"))
}

/**
 * Where the authentication command lives, derived from the interpreter
 * (§5.11 认证命令的定位).
 *
 * It ships with the client library, so its location is whatever the
 * environment's layout puts it at — never a fixed path, and never something to
 * assume is on PATH: the interpreter the user configured may well belong to an
 * environment that is not the active one.
 *
 *   macOS/Linux venv or conda:  <env>/bin/python3        → <env>/bin/earthengine
 *   Windows venv:               <env>/Scripts/python.exe → <env>/Scripts/earthengine.exe
 *   Windows conda:              <env>/python.exe         → <env>/Scripts/earthengine.exe
 *
 * The filesystem is probed on Windows because its two layouts disagree about
 * where the command sits relative to the interpreter, and a path that is
 * merely plausible is not copy-pasteable.
 */
function authCommand(python: string): string {
  const directory = path.dirname(python)
  if (process.platform !== "win32") return quote(path.join(directory, "earthengine"))
  const beside = path.join(directory, "earthengine.exe")
  if (existsSync(beside)) return quote(beside)
  // Neither layout has it yet. Guess conda's, because that is the one whose
  // interpreter sits at the environment root while its commands live a
  // directory below — the arrangement someone reading a path would get wrong.
  return quote(path.join(directory, "Scripts", "earthengine.exe"))
}

/**
 * The four steps, in the order the probe checks them (§5.3).
 *
 * The probe short-circuits, so where it stopped IS which step the user is on —
 * the ladder here and the chain there are the same chain, and adding a check
 * without adding a rung would leave someone stranded on a step nobody names.
 */
const STEPS = [
  "Configure a Python interpreter",
  "Install the required Python packages",
  "Sign in with your Google account",
  "Configure your Google Cloud project ID",
] as const

/**
 * Where the user stands on the chain (§5.11 分步推进模型).
 *
 * Rendered from one list so the four states cannot drift apart. The old build
 * wrote this passage by hand in each formatter, and the wording of what
 * remained had already begun to differ between them.
 *
 * The whole ladder is shown rather than just the current rung: someone landing
 * on step 1 should see how far it is to the end before deciding to start, and
 * someone on step 3 should see that they are nearly done.
 */
function progress(current: 1 | 2 | 3 | 4): string[] {
  return [
    `Step ${current} of ${STEPS.length}: ${STEPS[current - 1]}.`,
    ...STEPS.map((step, index) => {
      const position = index + 1
      if (position < current) return `  done  ${position}. ${step}`
      if (position === current) return `  →     ${position}. ${step}`
      return `        ${position}. ${step}`
    }),
  ]
}

/** The smoke test that advances the chain, quoted the same way everywhere. */
const SMOKE_TEST = ["  from geocode import init_gee", "  init_gee()", "  print('GEE ready')"]

/** Saving the file re-probes; no restart. The loop-closing fact (§3.1). */
const WATCHED = "GeoCode watches machine.json and re-probes the moment it is saved — no restart."

// Step 1 — the interpreter. Agent's to complete. --------------------------------

function unconfigured(): string {
  const windows = process.platform === "win32"
  // A JSON string, so Windows separators are doubled here as the user must
  // type them. The probe commands further down are shell, and are not.
  const example = windows
    ? "C:\\\\Users\\\\<you>\\\\miniforge3\\\\envs\\\\geo\\\\python.exe"
    : "/Users/<you>/miniforge3/envs/geo/bin/python3"
  return [
    "Google Earth Engine is not configured yet.",
    "",
    ...progress(1),
    "",
    `Configuration file: ${machineJson()}`,
    `Required field: "gee.python" — a Python interpreter with the Earth Engine`,
    "                packages installed. Every GEE script runs through it.",
    "",
    "There is no standard install location for this. Most users keep an",
    "isolated environment built with conda, miniforge, or venv. If one already",
    `exists with ${GeeDeps.PACKAGES.join(", ")} installed, point "gee.python"`,
    "at its interpreter and this step is done.",
    "",
    "To configure, edit the file above:",
    "{",
    `  "gee": {`,
    `    "python": "${example}"`,
    "  }",
    "}",
    "",
    "Note for the agent: offer to find or create an environment for the user.",
    "",
    "  1. Look for one that already exists:",
    "       conda env list",
    windows ? "       where python" : "       which -a python3",
    "     Confirm the candidate with the user before writing anything. Do NOT",
    "     pick one automatically, especially when there are several — the user",
    "     knows which environment is theirs to change.",
    "",
    "  2. If there is none, create one:",
    "       conda create -n <name> python=3.12 -y",
    "",
    "  3. Install the packages ONE AT A TIME, one command per package:",
    ...GeeDeps.PACKAGES.map((pkg) => `       <env-python> -m pip install ${pkg}`),
    "     Each takes 30s-2min. Run together they become a single multi-minute",
    "     command with no output, and the user cannot tell it apart from a",
    "     hang. Separately, every package that lands is visible progress.",
    "",
    `  4. Verify: <env-python> -c "import ${GeeDeps.DEPS.map((dep) => dep.module).join(", ")}; print('ok')"`,
    "",
    "  5. ONLY after the verify succeeds, write gee.python to the file above.",
    "",
    "  6. Then run a minimal script to reach the next step:",
    ...SMOKE_TEST,
    "",
    "Default response template (adapt the wording, keep the intent):",
    "",
    `  "Earth Engine needs a Python environment with its client library`,
    `   installed. Do you already have one? I can look for candidates with`,
    `     conda env list`,
    windows ? `     where python` : `     which -a python3`,
    `   If there isn't one, I can walk you through creating it. Shall I look`,
    `   first?"`,
    "",
    WATCHED,
  ].join("\n")
}

function pythonMissing(python: string): string {
  return [
    "The configured Python interpreter does not exist.",
    "",
    ...progress(1),
    "",
    `Configuration file: ${machineJson()}`,
    `Configured gee.python: ${python}`,
    "",
    "The path is set but nothing is there. Usually the environment was moved",
    "or deleted, the path has a typo, or this configuration was copied from",
    "another machine.",
    "",
    "Note for the agent: offer to help locate the right path.",
    "Default response template:",
    "",
    `  "The Python interpreter configured for Earth Engine isn't there:`,
    `     ${python}`,
    `   Did the environment move? I can search for it (conda env list, ls).`,
    `   Shall I look?"`,
    "",
    "Confirm the path with the user before writing it to the file above.",
    WATCHED,
  ].join("\n")
}

// Step 2 — the packages. Agent's to complete. -----------------------------------

function packagesMissing(python: string, missing: readonly string[]): string {
  // An empty list means the probe reported nothing specific; the whole
  // manifest is the honest answer rather than an empty install command.
  const packages = missing.length > 0 ? missing : GeeDeps.PACKAGES
  const roles = packages.map((pkg) => {
    const dep = GeeDeps.byPackage(pkg)
    return dep ? `  ${dep.pkg}: ${dep.role}` : `  ${pkg}`
  })
  const commands = packages.map((pkg) => `  ${quote(python)} -m pip install ${pkg}`)

  /* The conda-forge alternative, offered only when BOTH signals hold: the
   * interpreter belongs to a conda environment AND geopandas is among what is
   * missing. geopandas is the one dependency here that pulls GDAL-bound C
   * extensions (fiona, pyogrio), which is where pip wheels can ABI-mismatch
   * what conda already installed. Showing conda commands to a venv user is
   * noise; showing them for pure-Python packages is caution with no cause. */
  const condaForge =
    isConda(python) && packages.includes("geopandas")
      ? [
          "",
          "If you would rather use conda-forge — worth it in a conda environment,",
          "because geopandas pulls in fiona and pyogrio, which bind to GDAL and",
          "can ABI-mismatch pip wheels against what conda already installed:",
          ...packages.map((pkg) => `  conda install -c conda-forge ${pkg}`),
          "  (this one needs `conda` on PATH; the commands above always work)",
        ]
      : []

  return [
    `Required Python packages are missing: ${packages.join(", ")}.`,
    "",
    ...progress(2),
    "",
    `Configuration file: ${machineJson()}`,
    `Python interpreter: ${python}`,
    "",
    "What each one is for:",
    ...roles,
    "",
    "To install, run these ONE AT A TIME — one command per package:",
    ...commands,
    "",
    "Each takes 30s-2min. Run together they become a single multi-minute",
    "command with no output, and the user cannot tell it apart from a hang.",
    "",
    "They go through the configured interpreter on purpose. A package manager",
    "found on PATH may belong to a different environment than the one",
    "configured here, and installing into the wrong environment leaves this",
    "state exactly as it was.",
    ...condaForge,
    "",
    "Note for the agent: offer to run the installs for the user.",
    "Default response template:",
    "",
    `  "Earth Engine is missing some Python packages (${packages.join(", ")}).`,
    `   I can install them — one at a time, roughly a minute each.`,
    `   Shall I start?"`,
    "",
    "If the user agrees, run each command and wait for it to finish before",
    'starting the next one — pip ends with a "Successfully installed ..."',
    "line, and a package that resolved dependencies but failed to build says",
    "so there. Then call the GEE tool again; the next check picks up what",
    "was installed.",
    "",
    "Do NOT just print the commands and wait passively. Take initiative.",
  ].join("\n")
}

// Step 3 — the sign-in. The agent guides; the user performs. --------------------

/**
 * The one step the Agent cannot finish on its own, and the copy is written
 * around that.
 *
 * The command opens a browser and waits for a human to approve — so the Agent
 * running it before the user is ready produces a browser window nobody is
 * watching and a command that eventually gives up. Hence the two-beat wait:
 * ask first, run only on the user's word, then wait again for them to say the
 * browser part is done. The old build had exactly this shape; it is the
 * difference between guiding and barging.
 *
 * Note what this does NOT do: start an authorization flow inside the app.
 * The service process cannot drive a browser (§5.11 硬边界 1), and the command
 * below is the user's own terminal doing what it is built to do.
 */
function credentialsMissing(python: string): string {
  const command = `${authCommand(python)} authenticate`
  return [
    "Earth Engine is not signed in on this machine.",
    "",
    ...progress(3),
    "",
    `Configuration file: ${machineJson()}`,
    `Python interpreter: ${python}`,
    "",
    "To sign in, run:",
    `  ${command}`,
    "",
    "This opens a browser to authorize access to Earth Engine. The command",
    "ships with the earthengine-api package already installed here — nothing",
    "more to install. On success it writes credentials under the home",
    "directory, in .config/earthengine/, and exits on its own.",
    "",
    "Note for the agent: ask the user to have their Google account ready",
    "FIRST. Do NOT run the command until they say they are. It opens a browser",
    "and waits for a person; started too early it is a window nobody is",
    "looking at and a command that times out.",
    "",
    "Default response template:",
    "",
    `  "Earth Engine needs you to sign in with Google. Have your account`,
    `   ready, and tell me when you are — I'll open the sign-in for you by`,
    `   running:`,
    `     ${command}`,
    `   A browser window opens. Finish the authorization there, then come`,
    `   back and tell me it's done."`,
    "",
    "When the user says they are ready, run the command. When they say the",
    "browser part is done, verify with a minimal script:",
    ...SMOKE_TEST,
    "",
    "Do NOT just print the command and wait passively. Take initiative.",
  ].join("\n")
}

// Step 4 — the project. The user's alone. ---------------------------------------

function projectMissing(): string {
  return [
    "The Google Cloud project is not configured.",
    "",
    ...progress(4),
    "",
    `Configuration file: ${machineJson()}`,
    `Required field: "gee.project" — a Google Cloud project with the Earth`,
    "                Engine API enabled. Every script initializes against it,",
    "                and Earth Engine refuses to start without one: it is how",
    "                Google attributes quota and grants access.",
    "",
    "Where to find it:",
    "  - Open https://code.earthengine.google.com and sign in with the same",
    `    Google account used above. The project is shown at the top (e.g. "ee-yourname").`,
    "  - Or create one and enable the API at:",
    "    https://console.cloud.google.com/apis/library/earthengine.googleapis.com",
    "",
    "Add it beside the interpreter already configured:",
    "{",
    `  "gee": {`,
    `    "python": "...the path already there...",`,
    `    "project": "your-project-id"`,
    "  }",
    "}",
    "",
    "Note for the agent: only the user can supply this. NEVER invent one, and",
    "never guess from their name or their files — it is a real resource under",
    "their account, and a wrong value is rejected by Google with an error that",
    "reads like a permissions problem.",
    "",
    "Default response template:",
    "",
    `  "One last thing: Earth Engine needs your Google Cloud project ID. Do`,
    `   you have one? It's shown at the top of the editor at`,
    `   https://code.earthengine.google.com. Give it to me and I'll add it`,
    `   to your configuration."`,
    "",
    "Once the user provides it, write it to the file above, then verify:",
    ...SMOKE_TEST,
    "",
    WATCHED,
  ].join("\n")
}

// The probe itself failed — not a rung on the chain. ---------------------------

/**
 * Neither "your setup is incomplete" nor "the remote said no": the local check
 * did not get to answer.
 *
 * The interpreter is not echoed here the way the QGIS sibling echoes its own,
 * because these two states do not carry it — a caller who needs it reads the
 * configuration file, which the copy names. Worth revisiting if it turns out
 * an agent cannot act without it.
 */
function probeBroken(symptom: string, error?: string): string {
  return [
    `${symptom} — so whether the local environment is complete is unknown.`,
    "",
    `Configuration file: ${machineJson()}`,
    ...(error ? ["", `Probe error: ${error}`] : []),
    "",
    "The check imports the required packages and looks for credentials. It",
    "starts no network connection, so this is not a connectivity problem.",
    "",
    "Note for the agent: find out whether the interpreter itself runs, before",
    "changing anything.",
    `  1. Read gee.python from the file above.`,
    `  2. Run: <gee-python> -c "print('ok')"`,
    "  3. If that fails, the environment is broken or the path points at",
    "     something that is not a Python interpreter — offer to locate or",
    "     rebuild it with the user.",
    "  4. If it succeeds, run the imports one at a time to find which one",
    "     hangs or raises:",
    ...GeeDeps.DEPS.map((dep) => `       <gee-python> -c "import ${dep.module}"`),
    "",
    "Do NOT rewrite the configuration on a guess, and do NOT reinstall",
    "packages before knowing which one is the problem.",
    "",
    // Both paths out of here re-run the check, and which one applies depends on
    // what the agent found: a wrong path is fixed in the file, a broken
    // environment is fixed outside it — and the second would look like a dead
    // end if only the file were named (§5.8).
    "Once the environment is fixed, calling a GEE tool again re-runs this check.",
    WATCHED,
  ].join("\n")
}

// The three layers. -------------------------------------------------------------

function setupGuidance(setup: GeoEvent.GeeSetup): string {
  switch (setup.status) {
    case "unconfigured":
      return unconfigured()
    case "config-error":
      return [
        `machine.json cannot be parsed: ${setup.message} (${setup.file}).`,
        "Every geographic capability is off until the file parses again — fix that",
        "line first; the file takes effect the moment it is saved.",
      ].join("\n")
    case "python-missing":
      return pythonMissing(setup.python)
    case "checking":
      return "Earth Engine's environment is still being checked — the first check after a configuration change can take a while. Try again shortly."
    case "packages-missing":
      return packagesMissing(setup.python, setup.missing)
    case "credentials-missing":
      return credentialsMissing(setup.python)
    case "project-missing":
      return projectMissing()
    case "probe-timeout":
      return probeBroken("The environment check got no answer within its time limit")
    case "probe-failed":
      return probeBroken("The environment check failed before reporting", setup.error)
    case "ready":
      // Unreachable through `render`, which routes a ready setup to the layer
      // that is actually in the way. Present so the switch stays exhaustive.
      return ""
  }
}

/**
 * The network layer (§5.11 硬边界 3).
 *
 * The prohibitions are the substance of this branch, not a footnote. Everything
 * local is verified by the time anyone reads this — so every repair an Agent
 * might reach for is not merely useless but destructive: reinstalling packages
 * churns a working environment, re-authenticating cannot complete over a link
 * that carries nothing, and rewriting the configuration edits the one part
 * that is already correct.
 */
function networkGuidance(python: string, project: string, checking: boolean): string {
  if (checking) {
    return "Earth Engine's reachability is still being checked. Try again shortly."
  }
  return [
    "Earth Engine cannot be reached over the network.",
    "",
    `Python interpreter: ${python}`,
    `Configured project: ${project}`,
    "",
    "The local setup is complete: the interpreter is configured, the packages",
    "are installed, credentials exist, and the project is set. All four steps",
    "are done. What is missing is a route to Earth Engine.",
    "",
    "GeoCode already tries what it can reach on its own — inherited proxy",
    "environment variables, the system proxy, a direct route, and common local",
    "proxy ports. There is no proxy setting to configure here.",
    "",
    "Note for the agent: do NOT reinstall Python packages, do NOT edit",
    "machine.json, and do NOT ask the user to sign in again. None of those is",
    "the problem, and each one damages something that is already correct.",
    "",
    "What helps: check that the machine is online, and that a proxy or VPN is",
    "running if this network needs one to reach Google at all. If there is one",
    "and it is still failing, check its MODE — a proxy serving only SOCKS is a",
    "common cause here, and switching it to HTTP or mixed mode is usually the",
    "whole fix.",
    "",
    "Then call the GEE tool again. Reachability is re-checked without",
    "restarting anything.",
  ].join("\n")
}

/**
 * The remote layer.
 *
 * Everything local and every route is verified; Google itself refused. The
 * attribution travels beside its raw message because our reading of that
 * message can be wrong, and the user should see what was actually said.
 */
function runtimeGuidance(python: string, project: string, runtime: GeoEvent.GeeRuntime): string {
  if (runtime.status === "checking") {
    return "Earth Engine authorization is being verified. Try again shortly."
  }
  if (runtime.status !== "failed") {
    // `unknown` — nothing has asked yet (§5.5). The check is lazy, and the gate
    // is what triggers it, so this is a status reader's view rather than
    // anything a tool call would land on. Saying "call a GEE tool" here would
    // be circular advice for the one caller that could see it by accident.
    return "Earth Engine authorization has not been checked yet — it is verified the first time a script runs."
  }

  const reauth = `${authCommand(python)} authenticate --force`

  /* One fix per attribution. The point of classifying the rejection at all is
   * to open with the single thing most likely to be wrong; collapsing these
   * into a shared paragraph would leave the attribution as decoration. */
  const likeliest = ((): string[] => {
    switch (runtime.reason) {
      case "api-disabled":
        return [
          "  Enable the Earth Engine API for this project:",
          "  https://console.cloud.google.com/apis/library/earthengine.googleapis.com",
          `  Project: ${project}`,
        ]
      case "permission-denied":
        return [
          "  The signed-in Google account lacks permission for this project or",
          "  for Earth Engine. Ask the project owner to grant access, or switch",
          "  to a project and account the user owns.",
        ]
      case "credentials-expired":
        return [
          "  Credentials exist but are invalid, stale, revoked, or belong to a",
          "  different account. Sign in again with:",
          `    ${reauth}`,
        ]
      case "project-invalid":
        return [
          "  Check the configured project. If it is wrong, update gee.project in",
          "  machine.json to the one shown in the Earth Engine editor.",
        ]
      case "unknown":
        return [
          "  Read Google's message above and choose the narrowest project, API,",
          "  permission, or credential fix it points at. Do not reinstall local",
          "  packages — nothing local is in question here.",
        ]
    }
  })()

  return [
    "Google refused to authorize Earth Engine.",
    "",
    `Python interpreter: ${python}`,
    `Configured project: ${project}`,
    `Attributed to:      ${runtime.reason}`,
    "",
    "Message from Google:",
    `  ${runtime.message}`,
    "",
    "Most likely fix:",
    ...likeliest,
    "",
    "Everything local is in place and the network is fine — this is the last",
    "layer. Four causes account for nearly all of it, roughly in order:",
    "",
    "1. Wrong project ID. Check it against the top of the editor at",
    "   https://code.earthengine.google.com, and fix it in machine.json.",
    "",
    "2. Earth Engine API not enabled for the project:",
    "   https://console.cloud.google.com/apis/library/earthengine.googleapis.com",
    `   Enable it for "${project}".`,
    "",
    "3. Wrong Google account — signed in as one account, the project belongs",
    "   to another. Sign in again with:",
    `     ${reauth}`,
    "",
    "4. Access revoked. Ask the project owner to grant it again, or switch to",
    "   a project the user owns.",
    "",
    "Note for the agent: read Google's message and pick the SINGLE most likely",
    "cause from what it says. Do not list all four at the user — diagnose.",
    `  - "not registered" / "not found"     → cause 1 or 2`,
    `  - "permission" / "unauthorized"      → cause 3 or 4`,
    `  - "API" / "not enabled"              → cause 2`,
    "Propose one concrete fix and ask whether it matches their situation.",
    "",
    "After the fix lands — a configuration edit, a new sign-in, or a change in",
    "the Google Cloud console — verify with a minimal script:",
    ...SMOKE_TEST,
  ].join("\n")
}

/**
 * One voice for every not-ready state. A fully usable Earth Engine returns "".
 *
 * `facing` decides which layer speaks, because it already computed the
 * short-circuit (§5.6). The narrowing below is that invariant, not a guess: a
 * setup short of ready always faces "setup", so the later branches genuinely
 * have the interpreter and project they render.
 */
export function render(status: GeoEvent.GeeStatus): string {
  if (status.facing === "setup" || status.setup.status !== "ready") return setupGuidance(status.setup)
  const { python, project } = status.setup
  if (status.facing === "network") {
    // Reachable while facing the network layer means the fact settled between
    // the composition and this call. Nothing is wrong with the layer being
    // pointed at, and inventing a problem to describe would be worse than the
    // caller falling back to its own wording.
    if (status.network.status === "reachable") return ""
    return networkGuidance(python, project, status.network.status !== "unreachable")
  }
  if (status.runtime.status === "valid") return ""
  return runtimeGuidance(python, project, status.runtime)
}

export * as GeeGuidance from "./guidance"
