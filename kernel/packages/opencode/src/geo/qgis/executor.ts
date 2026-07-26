export * as QgisExecutor from "./executor"

import { Duration, Effect } from "effect"
import type { GeoRuntime } from "../runtime"
import { QgisBootstrap } from "./bootstrap"
import type { Algorithm } from "./catalog"
import type { Environment } from "./types"

/* --- GeoCode: the execution pipeline (docs/GEOKERNEL.md §4.12).
 *
 * Two call kinds, one pipeline: algorithm runs ride a standard runner script,
 * data reading rides its own scripts (2d follow-up) — both take a VERIFIED
 * environment object handed in by the gate, never a status they look up
 * themselves (§4.9, §9.1).
 *
 * Stateless on purpose: every execution is its own subprocess, and the
 * pipeline holds nothing between calls, so concurrent runs cannot see each
 * other (§4.12 并发). --- */

/**
 * The idle-clock floor and default, in seconds.
 *
 * Algorithm execution is the third-party-controlled tier of §8.4: plenty of
 * algorithms are silent for their whole runtime, so only the CALLER — who
 * knows the data size — can pick the number. The kernel enforces a floor
 * because a tiny value turns every normally-quiet algorithm into a "timeout",
 * and supplies a default for callers with no opinion.
 */
export const IDLE_FLOOR_SECONDS = 10
export const IDLE_DEFAULT_SECONDS = 60

/**
 * The runner. Ported from the build that survived production, with its
 * reasons:
 *
 * - Fault handler first, before any geo import (§4.13 constraint 4): a broken
 *   install segfaults during native library load where no except-block can
 *   see it; enabled first, at least the native stack reaches stderr.
 * - The feedback subclass prints a progress line at every ten percent. That
 *   is the progress CONTRACT of §4.12: it shows the user movement, and it is
 *   the heartbeat that lets a well-behaved algorithm run for hours under an
 *   idle clock.
 * - The in-script parameter check warns and NEVER blocks (§4.12): it reads
 *   the live registry — including the value-acceptability check only QGIS
 *   itself can answer — but QGIS's own validation at run time stays the
 *   ground truth, and our check breaking must not take the run with it.
 * - The algorithm's display name prints early so the caller can label the
 *   run while it is still going.
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
        _required = set()
        for p in _defs:
            try:
                if not (p.flags() & p.FlagOptional):
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
                [f"Missing: {sorted(_missing)}", "QGIS may use defaults if available, or fail."],
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

/** A pre-flight finding. Advice with a location, never a veto. */
export interface Hint {
  readonly kind: "unknown-algorithm" | "unknown-parameter" | "missing-required" | "invalid-choice"
  readonly message: string
}

/**
 * Millisecond-scale pre-flight against catalog metadata (§4.12).
 *
 * Complements, never replaces, the in-script check: this one answers before
 * any interpreter starts, from the exported metadata; the in-script one reads
 * the live registry and can ask value-acceptability. Both only ADVISE — the
 * exported metadata cannot express every constraint, and blocking on it would
 * turn its gaps into "the user cannot run this" (§4.12, and §12).
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

  for (const parameter of algorithm.parameters) {
    if (!parameter.optional && !(parameter.name in parameters)) {
      hints.push({
        kind: "missing-required",
        message: `Required parameter '${parameter.name}' is missing; QGIS may fall back to a default, or fail.`,
      })
    }
    // The one value judgment the metadata CAN make: an enum given a value
    // outside its options. Everything subtler belongs to QGIS at run time.
    const value = parameters[parameter.name]
    if (
      parameter.options.length > 0 &&
      (typeof value === "string" || typeof value === "number") &&
      !parameter.options.includes(String(value)) &&
      !(typeof value === "number" && value >= 0 && value < parameter.options.length)
    ) {
      hints.push({
        kind: "invalid-choice",
        message: `Parameter '${parameter.name}' expects one of its listed options (or an option index); got ${JSON.stringify(value)}.`,
      })
    }
  }
  return hints
}

/** The display name the runner prints early, for labelling a live run. */
export function displayName(output: string): string | undefined {
  return /^Algorithm name:\s*(.+)$/m.exec(output)?.[1]?.trim()
}

export interface AlgorithmOptions {
  readonly algorithm: string
  readonly parameters: Record<string, unknown>
  /** Idle limit in seconds — the §8.4 caller-given tier. Clamped to the floor; defaulted when absent. */
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

/**
 * Run one algorithm in a verified environment.
 *
 * Termination semantics come from Runtime and are not re-decided here: every
 * ending — normal, idle, abort, crash — returns the output gathered so far
 * with its reason attached (§4.12). Presentation of those endings is the tool
 * layer's job.
 */
export function runAlgorithm(
  runtime: GeoRuntime.Interface,
  environment: Environment,
  options: AlgorithmOptions,
): Effect.Effect<GeoRuntime.Result, Error> {
  return runScript(runtime, environment, {
    script: RUNNER_SCRIPT,
    // Parameters travel as an argument, matching the production-tested form.
    // The runner reads argv, so the bootstrap wrapper must preserve argv
    // semantics — which wrapInline does by construction (§4.5).
    args: [options.algorithm, JSON.stringify(options.parameters)],
    idleSeconds: options.idleSeconds,
    onChunk: options.onChunk,
    abort: options.abort,
    cwd: options.cwd,
  })
}

/** Run an inline script in a verified environment — the same single pipeline. */
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
