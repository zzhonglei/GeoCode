import { existsSync } from "node:fs"
import * as path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { GeoEvent } from "@opencode-ai/schema/geo-event"
import { GeeDeps } from "./deps"

/* --- GeoCode: the guidance shown when Earth Engine is not ready, for the layer `facing` has already chosen
 * (docs/GEOKERNEL.md §5.11). --- */

const machineJson = () => path.join(Global.Path.config, "machine.json")

function quote(target: string): string {
  return process.platform === "win32" ? `"${target}"` : `'${target}'`
}

/**
 * `conda-meta/` rather than a name like "miniforge" in the path, which can be renamed; the environment root is two
 * levels above a Unix interpreter (`<env>/bin/python`) and one above a Windows one (`<env>/python.exe`).
 */
function isConda(python: string): boolean {
  const root = process.platform === "win32" ? path.dirname(python) : path.dirname(path.dirname(python))
  return existsSync(path.join(root, "conda-meta"))
}

/** Derived from the interpreter, never assumed to be on PATH: the configured environment may not be the active one. */
function authCommand(python: string): string {
  const directory = path.dirname(python)
  if (process.platform !== "win32") return quote(path.join(directory, "earthengine"))
  const beside = path.join(directory, "earthengine.exe")
  if (existsSync(beside)) return quote(beside)
  // Not beside the interpreter, so guess conda's layout, whose commands sit a directory below it.
  return quote(path.join(directory, "Scripts", "earthengine.exe"))
}

/** In the probe's order: where §5.3's short-circuit stopped is the step the user is on. */
const STEPS = [
  "Configure a Python interpreter",
  "Install the required Python packages",
  "Sign in with your Google account",
  "Configure your Google Cloud project ID",
] as const

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

const smokeTest = (indent = "  ") => [
  `${indent}from geocode import init_gee`,
  `${indent}init_gee()`,
  `${indent}print('GEE ready')`,
]

/**
 * Only where the fix changes the `gee` block, because Config drops an unchanged one (`config/index.ts`); the probe
 * states pair it with the tool retry, which re-probes them.
 */
const WATCHED = "GeoCode watches machine.json and re-probes the moment it is saved — no restart."

/** Repeated into every state that installs anything: the response templates only demonstrate asking. */
const PERMISSION = [
  "ALWAYS get the user's agreement before changing their Python environment —",
  "creating one, installing into one, replacing a package. Ask, and wait for",
  "the answer. It is their machine and their environment.",
]

function unconfigured(): string {
  const windows = process.platform === "win32"
  // Rendered inside a JSON string below, so Windows separators are doubled here exactly as the user must type them.
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
    `exists with ${GeeDeps.PACKAGES.join(", ")} installed,`,
    `point "gee.python" at its interpreter and this step is done.`,
    "",
    "To configure, edit the file above:",
    "{",
    `  "gee": {`,
    `    "python": "${example}"`,
    "  }",
    "}",
    "",
    "Note for the agent: offer to find or create an environment for the user.",
    ...PERMISSION,
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
    "     Do NOT install conda or miniforge yourself. If the user has neither,",
    "     that is theirs to install.",
    "",
    "  3. Install the packages ONE AT A TIME, one command per package:",
    ...GeeDeps.PACKAGES.map((pkg) => `       <env-python> -m pip install ${pkg}`),
    "     Each takes 30s-2min. Run together they become a single multi-minute",
    "     command with no output, and the user cannot tell it apart from a",
    "     hang. Separately, every package that lands is visible progress.",
    "",
    `  4. Verify: <env-python> -c "import ${GeeDeps.DEPS.map((dep) => dep.module).join(", ")}; print('ok')"`,
    "",
    "  5. ONLY after the verify succeeds, use the Edit tool to write gee.python",
    "     into the file above. Edit it in place — machine.json also holds the",
    "     QGIS and GDAL settings, and rewriting the whole file to add one field",
    "     is how those get lost.",
    "",
    "  6. Then run a minimal script to reach the next step:",
    ...smokeTest("       "),
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
    "Confirm the path with the user, then use the Edit tool to correct it in the",
    "file above — in place, so the QGIS and GDAL blocks beside it survive.",
    WATCHED,
  ].join("\n")
}

function packagesMissing(python: string, missing: readonly string[]): string {
  // The schema allows an empty list though the probe never sends one (`setup.ts` guards on length); an empty
  // install command would read as "nothing to do" in a state that blocks everything.
  const packages = missing.length > 0 ? missing : GeeDeps.PACKAGES
  const roles = packages.map((pkg) => {
    const dep = GeeDeps.byPackage(pkg)
    return dep ? `  ${dep.pkg}: ${dep.role}` : `  ${pkg}`
  })
  const commands = packages.map((pkg) => `  ${quote(python)} -m pip install ${pkg}`)

  // Both signals or neither: conda commands are noise to a venv user, and geopandas is the entry whose install
  // binds to GDAL (through pyogrio), where a pip wheel can mismatch what conda already installed.
  const condaForge =
    isConda(python) && packages.includes("geopandas")
      ? [
          "",
          "If you would rather use conda-forge — worth it in a conda environment,",
          "because geopandas pulls in fiona and pyogrio, which bind to GDAL and",
          "can ABI-mismatch pip wheels against what conda already installed:",
          // One command, unlike the pip lines above: conda solves the whole environment per invocation.
          `  conda install -c conda-forge ${packages.join(" ")}`,
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
    ...PERMISSION,
    "",
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
    // The initiative is in offering: beside the permission rule above, a bare "take initiative" reads as licence.
    "Do NOT just print the commands and leave them there. Offer to run them.",
  ].join("\n")
}

/** Still step 2, and the opposite fix: `packagesMissing`'s advice would install what is already installed. */
function packagesBroken(python: string, pkg: string, error: string): string {
  const dep = GeeDeps.byPackage(pkg)
  const conda = isConda(python)
    ? [
        "",
        "This is a conda environment, and that is very likely the cause: a pip",
        "wheel built against one version of a native library, sitting next to the",
        "one conda installed. Prefer conda-forge here, which builds against the",
        "same libraries as the rest of the environment:",
        `  conda install -c conda-forge --force-reinstall ${pkg}`,
      ]
    : []
  return [
    `${pkg} is installed, but importing it fails.`,
    "",
    ...progress(2),
    "",
    `Configuration file: ${machineJson()}`,
    `Python interpreter: ${python}`,
    "",
    "Error:",
    `  ${error}`,
    ...(dep ? ["", `${pkg} is needed for: ${dep.role}`] : []),
    "",
    "Installing it again will not fix this — it is already installed. An import",
    "that raises like this is the installation itself being unusable: a native",
    "library that will not load, or a binary built against a different version",
    "of something it links to.",
    ...conda,
    "",
    "Note for the agent: replace the installation rather than adding to it.",
    ...PERMISSION,
    "",
    `  1. ${quote(python)} -m pip install --force-reinstall --no-cache-dir ${pkg}`,
    "  2. Check it directly, without the rest of the chain:",
    `       ${quote(python)} -c "import ${dep?.module ?? pkg}"`,
    "  3. If it still raises, the environment is the problem, not the package.",
    "     Offer to build a fresh one and point gee.python at it — that is step 1",
    "     of this chain, and it is the reliable fix.",
    "",
    "Do NOT tell the user the package is missing. It is not, and they will have",
    "watched it install successfully.",
    "",
    "Then call the GEE tool again; the check runs from the start.",
  ].join("\n")
}

/** The agent cannot finish this step: the command waits at a browser for a person, and the service cannot drive one. */
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
    ...smokeTest(),
    "",
    "Do NOT just print the command and wait passively. Take initiative.",
  ].join("\n")
}

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
    "Once the user provides it, use the Read and Edit tools to add it to the gee",
    "block in the file above — in place, leaving the other blocks untouched.",
    "Then verify:",
    ...smokeTest(),
    "",
    WATCHED,
  ].join("\n")
}

/** The check did not get to answer, so no step is claimed — and neither state carries the interpreter to echo. */
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
    // Two routes out, because the fix may be outside the file: a wrong path is corrected in machine.json, a broken
    // environment is not, and naming only the file would leave the second looking like a dead end (§5.8).
    "Once the environment is fixed, calling a GEE tool again re-runs this check.",
    WATCHED,
  ].join("\n")
}

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
    case "packages-broken":
      return packagesBroken(setup.python, setup.pkg, setup.error)
    case "credentials-missing":
      return credentialsMissing(setup.python)
    case "project-missing":
      return projectMissing()
    case "probe-timeout":
      return probeBroken("The environment check got no answer within its time limit")
    case "probe-failed":
      return probeBroken("The environment check failed before reporting", setup.error)
    case "ready":
      // `compose` never pairs a ready setup with facing "setup", so only a hand-built status reaches this arm;
      // it is here to keep the switch exhaustive.
      return ""
  }
}

/**
 * Nothing about routes or proxies: an agent cannot reconfigure the user's proxy software, and the vocabulary only
 * invites a diagnosis it cannot make.
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
    "are done. This machine's network connection is what cannot currently",
    "reach Earth Engine.",
    "",
    "Note for the agent: do NOT reinstall Python packages, do NOT edit",
    "machine.json, and do NOT ask the user to sign in again. None of those is",
    "the problem, and each one damages something that is already correct.",
    "Tell the user their network cannot reach Earth Engine at the moment and",
    "leave the connection itself to them.",
    "",
    "Then call the GEE tool again. Reachability is re-checked without",
    "restarting anything.",
  ].join("\n")
}

/** Google's own words travel beside our attribution, because our reading of them can be wrong (§5.5). */
function runtimeGuidance(python: string, project: string, runtime: GeoEvent.GeeRuntime): string {
  if (runtime.status === "checking") {
    return "Earth Engine authorization is being verified. Try again shortly."
  }
  if (runtime.status !== "failed") {
    return "Earth Engine authorization has not been checked yet — it is verified the first time a script runs."
  }

  const reauth = `${authCommand(python)} authenticate --force`

  // One fix per attribution: a shared paragraph would leave the classification as decoration.
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
          "  machine.json — the id is shown at the top of the Earth Engine editor,",
          "  or in the Google Cloud console for a project created there.",
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
    `Configuration file: ${machineJson()}`,
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
    ...smokeTest(),
  ].join("\n")
}

/**
 * A usable Earth Engine returns "". The second disjunct is not redundant with `facing`: it keeps a contradictory
 * status on the local story, and narrows `setup` so the branches below can read its two fields.
 */
export function render(status: GeoEvent.GeeStatus): string {
  if (status.facing === "setup" || status.setup.status !== "ready") return setupGuidance(status.setup)
  const { python, project } = status.setup
  if (status.facing === "network") {
    // `compose` ties facing to this very field, so only a hand-built status reaches here: there is no problem left
    // to describe, and the caller has its own wording for that.
    if (status.network.status === "reachable") return ""
    return networkGuidance(python, project, status.network.status !== "unreachable")
  }
  if (status.runtime.status === "valid") return ""
  return runtimeGuidance(python, project, status.runtime)
}

export * as GeeGuidance from "./guidance"
