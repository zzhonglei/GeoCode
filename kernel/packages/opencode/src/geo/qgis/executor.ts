export * as QgisExecutor from "./executor"

import { Duration, Effect } from "effect"
import type { GeoRuntime } from "../runtime"
import { QgisBootstrap } from "./bootstrap"
import type { Algorithm } from "./catalog"
import type { Environment } from "./types"

/* --- GeoCode: the execution pipeline (docs/GEOKERNEL.md §4.12). --- */

/**
 * The idle clock is the caller's to pick, since only the caller knows the data size (§8.4); the floor keeps a tiny
 * value from turning every quiet algorithm into a "timeout".
 */
export const IDLE_FLOOR_SECONDS = 10
export const IDLE_DEFAULT_SECONDS = 60

/**
 * Three things the runner may not stop doing: enable the fault handler before any geo import, since a broken install
 * segfaults in native library load where no except-block can see it; print progress, the heartbeat the idle clock
 * reads; and warn without ever blocking the run.
 */
export const RUNNER_SCRIPT = `
import sys, faulthandler
faulthandler.enable(file=sys.stderr)

import json
from qgis.core import QgsApplication, QgsProcessingFeedback
from qgis import processing
from processing.core.Processing import Processing


class ProgressFeedback(QgsProcessingFeedback):
    """Report progress in real time: visibility for the user, heartbeat for the idle clock."""

    def __init__(self):
        super().__init__()
        self._last_pct = -1

    def setProgress(self, progress):
        pct = int(progress // 10) * 10
        if pct > self._last_pct:
            self._last_pct = pct
            print(f"Progress: {pct}%", flush=True)


qgs = QgsApplication([], False)
qgs.initQgis()
Processing.initialize()

algorithm = sys.argv[1]
params = json.loads(sys.argv[2])
registry = QgsApplication.processingRegistry()
algo = registry.algorithmById(algorithm)
name = algo.displayName().strip() if algo else ""

if name:
    print(f"Algorithm name: {name}", flush=True)

print(f"Starting algorithm: {algorithm}", flush=True)

def _print_warning(title, lines):
    print(f"Warning: {title}", flush=True)
    for line in lines:
        print(f"    {line}", flush=True)
    print("", flush=True)

try:
    if algo is None:
        _all_ids = [a.id() for a in registry.algorithms()]
        _al = algorithm.lower()
        _similar = [a for a in _all_ids if _al in a.lower() or a.lower() in _al][:5]
        if _similar:
            _print_warning(
                f"Algorithm '{algorithm}' not found in registry",
                [f"Did you mean: {', '.join(_similar)}"],
            )
        else:
            _print_warning(f"Algorithm '{algorithm}' not found in registry", [])
    else:
        _defs = algo.parameterDefinitions()
        _expected = {p.name() for p in _defs}
        # Only parameters QGIS has nothing to fall back on. A non-optional
        # parameter that ships a default is not a problem, and reporting it
        # here would repeat what the caller's own pre-flight already stated
        # WITH the values — this check reads the live registry and is worth
        # spending on the one thing that needs it, value acceptability below.
        _required = set()
        for p in _defs:
            try:
                if not (p.flags() & p.FlagOptional) and p.defaultValue() is None:
                    _required.add(p.name())
            except AttributeError:
                _required.add(p.name())
        _actual = set(params.keys())

        _unknown = _actual - _expected
        if _unknown:
            _print_warning(
                f"Unknown parameter(s) for '{algorithm}'",
                [f"Got: {sorted(_unknown)}", f"Defined: {sorted(_expected)}", "These will be ignored by QGIS."],
            )

        _missing = _required - _actual
        if _missing:
            _print_warning(
                f"Missing required parameter(s) for '{algorithm}'",
                [f"Missing: {sorted(_missing)}", "These have no default; QGIS will fail without them."],
            )

        from qgis.core import QgsProcessingContext
        _ctx = QgsProcessingContext()
        _bad = []
        for p in _defs:
            if p.name() not in params:
                continue
            _val = params[p.name()]
            try:
                if not p.checkValueIsAcceptable(_val, _ctx):
                    _bad.append((p.name(), p.type(), _val))
            except Exception:
                pass
        if _bad:
            _details = [f"{n} (type={t}): {v!r}" for n, t, v in _bad]
            _print_warning(
                f"Parameter value(s) may not be acceptable for '{algorithm}'",
                _details + ["QGIS will validate at run time - these are best-effort hints."],
            )
except Exception as _e:
    print(f"Warning: parameter pre-validation skipped due to error: {_e}", flush=True)
    print("", flush=True)

feedback = ProgressFeedback()

try:
    result = processing.run(algorithm, params, feedback=feedback)
    log = feedback.textLog().strip()
    if log:
        print(log)
    else:
        print(json.dumps(result, ensure_ascii=False, default=str))
except Exception as e:
    log = feedback.textLog().strip()
    if log:
        print(log, flush=True)
    print("Error: " + str(e), file=sys.stderr)
    sys.exit(1)
finally:
    qgs.exitQgis()
`

/**
 * `defaults-applied` is a statement, never merged into `missing-required`: so many non-optional parameters ship a
 * default that a correct call would raise alarms and teach the reader to skip the channel (§4.12).
 */
export interface Hint {
  readonly kind: "unknown-algorithm" | "unknown-parameter" | "missing-required" | "invalid-choice" | "defaults-applied"
  readonly message: string
}

/**
 * Advises only: the exported metadata cannot express every constraint, so blocking on it would turn its gaps into
 * "the user cannot run this".
 */
export function precheck(
  requestedId: string,
  algorithm: Algorithm | undefined,
  parameters: Record<string, unknown>,
  nearest: readonly string[] = [],
): Hint[] {
  if (!algorithm) {
    const suffix = nearest.length > 0 ? ` Did you mean: ${nearest.join(", ")}?` : ""
    return [{ kind: "unknown-algorithm", message: `Algorithm '${requestedId}' is not in the catalog.${suffix}` }]
  }

  const hints: Hint[] = []
  const defined = new Set(algorithm.parameters.map((parameter) => parameter.name))
  for (const name of Object.keys(parameters)) {
    if (!defined.has(name)) {
      hints.push({
        kind: "unknown-parameter",
        message: `Parameter '${name}' is not defined for ${algorithm.id}; QGIS will ignore it.`,
      })
    }
  }

  const defaulted: string[] = []
  for (const parameter of algorithm.parameters) {
    if (!(parameter.name in parameters)) {
      if (parameter.optional) continue
      if (parameter.defaultValue === null) {
        hints.push({
          kind: "missing-required",
          message: `Required parameter '${parameter.name}' is missing and has no default; QGIS will fail without it.`,
        })
      } else {
        defaulted.push(`${parameter.name}=${parameter.defaultValue}`)
      }
      continue
    }
    const value = parameters[parameter.name]
    // An option index counts as a number or as the string of one: generated JSON quotes numbers routinely, and QGIS
    // accepts both.
    const index =
      typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined
    if (
      parameter.options.length > 0 &&
      (typeof value === "string" || typeof value === "number") &&
      !parameter.options.includes(String(value)) &&
      !(index !== undefined && index >= 0 && index < parameter.options.length)
    ) {
      hints.push({
        kind: "invalid-choice",
        message: `Parameter '${parameter.name}' expects one of its listed options (or an option index); got ${JSON.stringify(value)}.`,
      })
    }
  }

  // With the values, since what QGIS is about to run with is a fact the caller may want to override.
  if (defaulted.length > 0) {
    hints.push({
      kind: "defaults-applied",
      message: `Not given, so QGIS will use its defaults: ${defaulted.join(", ")}.`,
    })
  }
  return hints
}

export function displayName(output: string): string | undefined {
  return /^Algorithm name:\s*(.+)$/m.exec(output)?.[1]?.trim()
}

export interface AlgorithmOptions {
  readonly algorithm: string
  readonly parameters: Record<string, unknown>
  readonly idleSeconds?: number
  readonly onChunk: (chunk: string) => Effect.Effect<void>
  readonly abort?: AbortSignal
  readonly cwd?: string
}

export interface ScriptOptions {
  readonly script: string
  readonly args?: readonly string[]
  readonly input?: string
  readonly idleSeconds?: number
  readonly onChunk: (chunk: string) => Effect.Effect<void>
  readonly abort?: AbortSignal
  readonly cwd?: string
}

export function runAlgorithm(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: AlgorithmOptions,
): Effect.Effect<GeoRuntime.Result, Error> {
  return runScript(runtime, environment, {
    script: RUNNER_SCRIPT,
    args: [options.algorithm, JSON.stringify(options.parameters)],
    idleSeconds: options.idleSeconds,
    onChunk: options.onChunk,
    abort: options.abort,
    cwd: options.cwd,
  })
}

export function runScript(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: ScriptOptions,
): Effect.Effect<GeoRuntime.Result, Error> {
  const requested = options.idleSeconds ?? IDLE_DEFAULT_SECONDS
  const idle = Math.max(IDLE_FLOOR_SECONDS, requested)
  return runtime.run({
    command: environment.python,
    args: ["-c", QgisBootstrap.wrapInline(options.script, environment.dllDirectories), ...(options.args ?? [])],
    env: environment.env,
    cwd: options.cwd,
    input: options.input,
    delivery: { mode: "incremental", onChunk: options.onChunk },
    clocks: { idle: Duration.seconds(idle) },
    abort: options.abort,
    label: "qgis:run",
  })
}
