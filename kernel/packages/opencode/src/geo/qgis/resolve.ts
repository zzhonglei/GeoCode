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

/* --- GeoCode: environment resolution, end to end (docs/GEOKERNEL.md §4.3–§4.6).
 *
 *   hint → reachability precheck → locate install → assemble → probe
 *        → (one retry, per platform) → verified environment or diagnostics
 *
 * Takes the runtime as a parameter rather than reading a status: this module
 * has no state and no opinions about WHEN to resolve — that is the
 * lifecycle's job (§4.10, arriving in 2b). --- */

/**
 * Reachability precheck (§4.3).
 *
 * Lenient where recovery exists, strict where it does not (principle 10): the
 * pipeline can recover from an imprecise ABSOLUTE hint — a wrong leaf, a
 * directory instead of a file — so those pass through to resolution. A
 * RELATIVE path is almost always a typo, and treating it leniently would turn
 * a clean "not found" into a late, hard-to-attribute probe error.
 */
function precheck(hint: string): "ok" | "path-missing" {
  if (!path.isAbsolute(hint)) return "path-missing"
  if (process.platform === "win32") {
    // The hint or its parent existing is enough: the launcher discovery can
    // recover the install from there.
    const win = path.win32
    return existsSync(hint) || existsSync(win.dirname(hint)) ? "ok" : "path-missing"
  }
  if (existsSync(hint)) return "ok"
  // A typo'd leaf under a real bundle is recoverable, and a bundle that turns
  // out not to be QGIS deserves its more specific verdict downstream. The
  // non-bundle fallback guess is NEITHER of those: it verified nothing, and
  // waving it through would turn a clean "not found" into a spawn error
  // wearing the whole probe script (§4.3 principle 10).
  const resolved = QgisMacOS.resolvePrefix(hint)
  return (resolved.prefix && resolved.verified) || resolved.notQgis ? "ok" : "path-missing"
}

export interface Hooks {
  /**
   * Fired once, immediately before the first probe subprocess starts.
   *
   * Exists so the lifecycle can surface `probing` as its own state: the two
   * intermediate states are split because their costs live in different places
   * — resolving in launcher export and directory search, probing in the probe
   * run — and merging them would lose exactly that attribution (§4.7).
   */
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
    // Once, whichever platform and track gets there first; retries stay in
    // `probing` rather than announcing it again.
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
      // The escape hatch (§4.3 principle 10): the bundle carries no marker,
      // but the hint IS a real interpreter the user pointed at. A missing
      // marker must not outrank a spawnable file — QGIS-derived and pruned
      // builds exist, and for them the probe is the only honest judge. The
      // verdict stays with the probe; everything else still gets the clean
      // not-qgis below.
      prefix = located.fallbackPrefix
    } else {
      return {
        ok: false as const,
        failure: "not-qgis" as const,
        diagnostics: QgisDiagnostics.bare(hint, "the path names an application bundle that is not QGIS"),
      }
    }

    // Pre-resolution discipline (§4.4): the hint is the interpreter only when
    // its NAME fits and the FILE exists — both, not either. The incident
    // behind the second half: a hint in the older layout's canonical shape on
    // a newer install names a file that is not there, and trusting the name
    // spawns nothing while the error points at the path the user "got right".
    // The user who mistyped the leaf recovered, because the name test failed
    // and derivation kicked in.
    const interpreterChoice = QgisMacOS.findInterpreter(prefix)
    const name = path.basename(hint)
    const interpreter =
      /^python(3(\.\d+)?)?$/i.test(name) && existsSync(hint) ? hint : (interpreterChoice.selected ?? hint)

    const assembly = QgisMacOS.assemble(prefix, interpreter)
    const choices: Record<string, Choice> = { ...assembly.choices, interpreter: interpreterChoice }

    yield* onProbing
    const first = yield* QgisProbe.run(runtime, interpreter, assembly.env, [])
    if (first.ok) return succeed(interpreter, prefix, assembly.env, [], undefined, first.report)

    // The one macOS retry (§4.6): the probe died at interpreter startup AND
    // layout detection found no standard library — an unknown new layout.
    // Search deeper for the encodings module, build the link structure, try
    // once more. This is what catches the NEXT layout change before anyone
    // has seen it.
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
 * Bounded search for a standard library anywhere under the bundle's contents:
 * a directory holding the encodings module. Only runs after a startup crash,
 * so its cost is paid exactly when there is nothing left to lose.
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
    // Two root strategies (§4.5), most specific intent first. Their coverage
    // is disjoint — see correctMidLayer for the layout only it reaches.
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

    // Track one: the bridge. The launcher is maintained by the QGIS project
    // and evolves with it; adopting its answer beats rebuilding it (§4.3
    // principle 2).
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
        // A launcher existed and its dump failed — that fact must survive to
        // the fallback's diagnostics AND the log, or "why am I on the manual
        // track with a perfectly good launcher" becomes unanswerable (§4.10).
        // Byte counts only: a dump carries every secret this process holds.
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
          // The bridge probe failed; its own failure would be the one shown if
          // the manual retry also fails, so the effective track must travel.
          // Bridge probe failed → manual retry, once (§4.6 回退). The two
          // tracks fail for entirely different reasons, so the second attempt
          // is a genuinely different experiment, not a repeat.
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
    // Root, by falling preference: what the launcher search settled on, any
    // strategy hit, the interpreter-shaped derivation, the hint's own parent
    // as a last resort — wrong roots yield missing candidates, and missing
    // candidates are exactly what the diagnostics render.
    const root =
      resolvedRoot ??
      rootCandidates.find(Boolean) ??
      QgisWindows.rootFromInterpreter(hint) ??
      QgisWindows.findRootByContent(hint) ??
      path.win32.dirname(hint)

    // The interpreter, discovered under the root rather than trusted from the
    // hint (§4.3 principle 1); the hint itself is the final fallback so the
    // probe's diagnostics show the exact path the user gave.
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
      // The track whose failure this is (§4.10 来源标记): the manual attempt
      // always runs last, so its assembly is what the diagnostics describe.
      track: "manual",
    })
  })
}

/**
 * Run the launcher's environment dump (§4.5 track one).
 *
 * On failure, log NOTHING raw: a successful dump contains every secret the
 * host process carries — the launcher inherits our environment through the
 * command interpreter — and failure output can echo variables too. The caller
 * falls back to the manual track, whose diagnostics carry only filtered views.
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
      // Raw output only when the script never spoke — that is when it IS the
      // diagnosis (§4.6); otherwise the step's own error suffices.
      output: outcome.startupCrash ? outcome.detail : undefined,
      error: outcome.startupCrash ? undefined : outcome.detail,
      attempted: context.attempted,
    }),
  }
}
