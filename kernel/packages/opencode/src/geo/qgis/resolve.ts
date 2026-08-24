export * as QgisResolve from "./resolve"

import { existsSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisDiagnostics } from "./diagnostics"
import { QgisMacOS } from "./macos"
import { QgisPaths } from "./paths"
import { QgisProbe } from "./probe"
import { QgisWindows } from "./windows"
import type { Choice, Environment, Resolution, Track } from "./types"

/* --- GeoCode: environment resolution, end to end (docs/GEOKERNEL.md §4.3–§4.6). No state and no status writes
 * here: the lifecycle in ./index.ts is the slot's only writer and decides when to resolve (§4.10). --- */

/** A relative hint is a typo; an imprecise absolute one goes on to resolution, which recovers (§4.3 可达性预检). */
function precheck(hint: string): "ok" | "path-missing" {
  if (!path.isAbsolute(hint)) return "path-missing"
  if (process.platform === "win32") {
    const win = path.win32
    return existsSync(hint) || existsSync(win.dirname(hint)) ? "ok" : "path-missing"
  }
  if (existsSync(hint)) return "ok"
  // Level 3 of resolvePrefix verifies nothing, so its guess is not a pass; a not-qgis bundle is one, because only
  // resolution can give it that more specific verdict.
  const resolved = QgisMacOS.resolvePrefix(hint)
  return (resolved.prefix && resolved.verified) || resolved.notQgis ? "ok" : "path-missing"
}

export interface Hooks {
  /** Fired immediately before the first probe run; the lifecycle shows `probing` from here on (§4.7). */
  readonly onProbing?: Effect.Effect<void>
}

export function resolve(hint: string, runtime: GeoRuntime.Interface, hooks: Hooks = {}): Effect.Effect<Resolution> {
  return Effect.gen(function* () {
    if (precheck(hint) === "path-missing") {
      return {
        ok: false as const,
        failure: "path-missing" as const,
        diagnostics: QgisDiagnostics.bare(hint, `path does not exist or is not absolute: ${hint}`),
      }
    }
    // Once per resolve, whichever track gets there first: a retry is still probing.
    let fired = false
    const onProbing = Effect.suspend(() => {
      if (fired || !hooks.onProbing) return Effect.void
      fired = true
      return hooks.onProbing
    })
    return process.platform === "win32"
      ? yield* resolveWindows(hint, runtime, onProbing)
      : yield* resolveMacOS(hint, runtime, onProbing)
  })
}

// --- macOS ------------------------------------------------------------------

function resolveMacOS(
  hint: string,
  runtime: GeoRuntime.Interface,
  onProbing: Effect.Effect<void>,
): Effect.Effect<Resolution> {
  return Effect.gen(function* () {
    const located = QgisMacOS.resolvePrefix(hint)
    let prefix: string
    if (located.prefix) {
      prefix = located.prefix
    } else if (located.fallbackPrefix && /^python(3(\.\d+)?)?$/i.test(path.basename(hint)) && existsSync(hint)) {
      // The escape hatch (§4.4): a missing marker must not veto a real interpreter, because derived and pruned
      // builds exist and the probe is the only judge of them. Anything else still gets the clean not-qgis below.
      prefix = located.fallbackPrefix
    } else {
      return {
        ok: false as const,
        failure: "not-qgis" as const,
        diagnostics: QgisDiagnostics.bare(hint, "the path names an application bundle that is not QGIS"),
      }
    }

    // Name AND existence, not either (§4.4 预解析纪律): an older-layout path given on a newer install has the right
    // shape and no file behind it, so trusting the name alone spawns nothing and blames a path the user got right.
    const interpreterChoice = QgisMacOS.findInterpreter(prefix)
    const name = path.basename(hint)
    const interpreter =
      /^python(3(\.\d+)?)?$/i.test(name) && existsSync(hint) ? hint : (interpreterChoice.selected ?? hint)

    const assembly = QgisMacOS.assemble(prefix, interpreter)
    const choices: Record<string, Choice> = { ...assembly.choices, interpreter: interpreterChoice }

    yield* onProbing
    const first = yield* QgisProbe.run(runtime, interpreter, assembly.env, [])
    if (first.ok) return succeed(interpreter, prefix, assembly.env, [], undefined, first.report)

    // The one macOS retry (§4.6 回退): startup crash plus no standard library from layout detection — an unknown
    // layout, so search by content, build the link structure and try once.
    if (first.startupCrash && !assembly.env.PYTHONHOME) {
      const contents = path.resolve(prefix, "..")
      const found = deepFindStandardLibrary(contents)
      if (found) {
        const home = QgisMacOS.ensurePythonHome(interpreter, found)
        if (home) {
          const retryEnv = { ...assembly.env, PYTHONHOME: home }
          const second = yield* QgisProbe.run(runtime, interpreter, retryEnv, [])
          if (second.ok) return succeed(interpreter, prefix, retryEnv, [], undefined, second.report)
          return fail(second, {
            python: interpreter,
            prefix,
            env: retryEnv,
            dllDirectories: [],
            choices: { ...choices, pythonHome: { selected: home, candidates: [found] } },
          })
        }
      }
    }

    return fail(first, { python: interpreter, prefix, env: assembly.env, dllDirectories: [], choices })
  })
}

/**
 * A directory holding the encodings module, found by content — unlike `findStandardLibrary`, which is keyed on the
 * `python3.NN` naming that an unknown layout is free to abandon.
 */
function deepFindStandardLibrary(contents: string): string | undefined {
  const pending: { dir: string; depth: number }[] = [{ dir: contents, depth: 0 }]
  const skip = new Set(["__pycache__", "site-packages", "plugins", "frameworks"])
  let visited = 0
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.pop()
    if (!current) continue
    visited += 1
    if (existsSync(path.join(current.dir, "encodings", "__init__.py"))) return current.dir
    if (current.depth >= 4) continue
    for (const dir of QgisPaths.subdirectories(current.dir)) {
      if (skip.has(path.basename(dir).toLowerCase())) continue
      pending.push({ dir, depth: current.depth + 1 })
    }
  }
  return undefined
}

// --- Windows ----------------------------------------------------------------

function resolveWindows(
  hint: string,
  runtime: GeoRuntime.Interface,
  onProbing: Effect.Effect<void>,
): Effect.Effect<Resolution> {
  return Effect.gen(function* () {
    // Two root strategies (§4.5), deduplicated because both can land on the same root. Only the mid-layer correction
    // reaches an install with no launcher — the segment scan accepts a candidate only when it carries one.
    const rootCandidates = QgisPaths.unique([QgisWindows.correctMidLayer(hint), QgisWindows.findRootFromHint(hint)])

    let launcher: string | undefined
    let resolvedRoot: string | undefined
    for (const root of rootCandidates) {
      const found = QgisWindows.findLauncher(root)
      if (found) {
        launcher = found
        resolvedRoot = root
        break
      }
    }

    const attempted: Track[] = []

    // Track one, the bridge: adopt the launcher's own answer rather than rebuild it (§4.3 principle 2).
    const launcherChoice: Record<string, Choice> =
      launcher && resolvedRoot
        ? {
            launcher: {
              selected: launcher,
              candidates: QgisWindows.LAUNCHER_NAMES.map((n) => path.win32.join(resolvedRoot!, "bin", n)),
            },
          }
        : {}
    if (launcher && resolvedRoot) {
      const dump = yield* dumpLauncherEnv(runtime, launcher)
      if (!dump.ok) {
        // Byte counts, never the output: the launcher runs with our environment and dumps exactly that, secrets
        // included. The warning is also the only record of why an install with a launcher ended on the manual track.
        yield* Effect.logWarning("qgis launcher env dump failed; falling back to manual assembly", {
          launcher,
          reason: dump.reason,
          stdoutBytes: dump.stdoutBytes,
          stderrBytes: dump.stderrBytes,
        })
        attempted.push("bridge")
        return yield* manualAttempt(hint, resolvedRoot, rootCandidates, runtime, attempted, launcherChoice, onProbing)
      }
      const dumped = dump.env
      {
        const adopted = QgisWindows.adoptBridgeDump(dumped, resolvedRoot)
        if (!adopted) {
          yield* Effect.logWarning("qgis launcher dump rejected: missing required keys", { launcher })
          attempted.push("bridge")
          return yield* manualAttempt(hint, resolvedRoot, rootCandidates, runtime, attempted, launcherChoice, onProbing)
        }
        {
          attempted.push("bridge")
          const choices: Record<string, Choice> = launcherChoice
          yield* onProbing
          const outcome = yield* QgisProbe.run(runtime, adopted.interpreter, adopted.env, [])
          if (outcome.ok) {
            return succeed(adopted.interpreter, adopted.prefix, adopted.env, [], "bridge", outcome.report)
          }
          // Bridge probe failed → manual retry, once (§4.6 回退). The manual outcome replaces this one in the
          // diagnostics; `attempted` is what still shows the bridge was tried.
          return yield* manualAttempt(hint, resolvedRoot, rootCandidates, runtime, attempted, choices, onProbing)
        }
      }
    }

    return yield* manualAttempt(hint, resolvedRoot, rootCandidates, runtime, attempted, launcherChoice, onProbing)
  })
}

function manualAttempt(
  hint: string,
  resolvedRoot: string | undefined,
  rootCandidates: readonly string[],
  runtime: GeoRuntime.Interface,
  attempted: Track[],
  inherited: Record<string, Choice>,
  onProbing: Effect.Effect<void>,
): Effect.Effect<Resolution> {
  return Effect.gen(function* () {
    attempted.push("manual")
    // Falling preference, ending in a guess rather than a failure: a wrong root yields candidates that do not exist,
    // and listing missing candidates is exactly what the diagnostics are for (§4.10).
    const root =
      resolvedRoot ??
      rootCandidates.find(Boolean) ??
      QgisWindows.rootFromInterpreter(hint) ??
      QgisWindows.findRootByContent(hint) ??
      path.win32.dirname(hint)

    // Derived from the root, not trusted from the hint (§4.3 principle 1); falling back to the hint keeps the user's
    // own path in the diagnostics.
    const interpreter = QgisWindows.findInterpreterUnderRoot(root) ?? hint

    const assembly = QgisWindows.assembleManual(interpreter, root, hint)
    const choices = { ...inherited, ...assembly.choices }

    yield* onProbing
    const outcome = yield* QgisProbe.run(runtime, interpreter, assembly.env, assembly.dllDirectories)
    if (outcome.ok) {
      return succeed(interpreter, assembly.prefix, assembly.env, assembly.dllDirectories, "manual", outcome.report)
    }
    return fail(outcome, {
      python: interpreter,
      prefix: assembly.prefix,
      env: assembly.env,
      dllDirectories: assembly.dllDirectories,
      choices,
      attempted,
      // The manual attempt always runs last, so its assembly is what these diagnostics describe (§4.10 来源标记).
      track: "manual",
    })
  })
}

/**
 * Run the launcher's environment dump (§4.5 track one). The result is the host environment plus the launcher's own
 * additions, so it is adopted whole and never logged or shown unfiltered (§4.3 principle 8).
 */
function dumpLauncherEnv(
  runtime: GeoRuntime.Interface,
  launcher: string,
): Effect.Effect<
  { ok: true; env: Record<string, string> } | { ok: false; reason: string; stdoutBytes: number; stderrBytes: number }
> {
  return Effect.gen(function* () {
    const result = yield* runtime
      .run({
        command: launcher,
        args: ["-c", QgisWindows.ENV_DUMP_SCRIPT],
        delivery: { mode: "collect" },
        clocks: { total: "15 seconds" },
        label: "qgis:env-dump",
      })
      .pipe(Effect.catch((error) => Effect.succeed(error)))
    if (result instanceof Error) {
      return {
        ok: false as const,
        reason: `spawn failed: ${result.message.split("\n")[0]}`,
        stdoutBytes: 0,
        stderrBytes: 0,
      }
    }
    if (result.reason !== "exit" || result.code !== 0) {
      return {
        ok: false as const,
        reason: `${result.reason}, exit code ${result.code}`,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      }
    }
    const extracted = GeoOutput.extractMarked(result.stdout, QgisWindows.ENV_DUMP_MARKER)
    if (!extracted.ok) {
      return {
        ok: false as const,
        reason: extracted.kind === "missing" ? "no marker in dump output" : "dump payload would not parse",
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      }
    }
    return { ok: true as const, env: extracted.value as Record<string, string> }
  })
}

// --- shared -----------------------------------------------------------------

function succeed(
  python: string,
  prefix: string,
  env: Record<string, string>,
  dllDirectories: readonly string[],
  track: Track | undefined,
  report: QgisProbe.Report,
): Resolution {
  const environment: Environment = {
    python,
    prefix,
    env,
    dllDirectories,
    track,
    versions: {
      python: report.pythonVersion,
      gdal: report.gdalVersion,
      qgis: report.qgisVersion ?? "",
    },
    processing: report.processingReady ?? false,
  }
  return { ok: true, environment }
}

function fail(
  outcome: Exclude<QgisProbe.Outcome, { ok: true }>,
  context: {
    python: string
    prefix: string
    env: Record<string, string>
    dllDirectories: readonly string[]
    choices: Record<string, Choice>
    attempted?: readonly Track[]
    track?: Track
  },
): Resolution {
  return {
    ok: false,
    failure: outcome.failure,
    diagnostics: QgisDiagnostics.build({
      python: context.python,
      prefix: context.prefix,
      env: context.env,
      dllDirectories: context.dllDirectories,
      choices: context.choices,
      track: context.track,
      // Raw output only for a startup crash, which is when it IS the diagnosis (§4.6 失败分级).
      output: outcome.startupCrash ? outcome.detail : undefined,
      error: outcome.startupCrash ? undefined : outcome.detail,
      attempted: context.attempted,
    }),
  }
}
