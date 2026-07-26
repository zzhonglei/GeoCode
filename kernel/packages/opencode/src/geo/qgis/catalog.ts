export * as QgisCatalog from "./catalog"

import { Context, Effect, Layer, Ref } from "effect"
import fuzzysort from "fuzzysort"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisBootstrap } from "./bootstrap"
import type { Environment } from "./types"

/* --- GeoCode: the algorithm catalog (docs/GEOKERNEL.md §4.11).
 *
 * QGIS itself is the only source of truth for algorithm metadata; the catalog
 * is produced by an export script running inside the verified environment and
 * lives in memory until the process ends. No disk cache, deliberately (§12):
 * that buys freedom from cache directories, version keys and invalidation
 * rules, and removes the risk of two same-versioned installs reading each
 * other's dump — at a build cost of a few seconds, in the background, behind a
 * visible "building" state.
 *
 * The lifecycle drives WHEN (build after each verification, void on each new
 * round); this module owns HOW and answers the queries. --- */

export interface Param {
  readonly name: string
  readonly description: string
  readonly type: string
  readonly defaultValue: string | null
  readonly options: readonly string[]
  readonly optional: boolean
}

export interface Output {
  readonly name: string
  readonly description: string
  readonly type: string
}

export interface Algorithm {
  readonly id: string
  readonly name: string
  readonly group: string
  readonly description: string
  /** Verbatim from QGIS — never trimmed, never rewritten (§4.11). */
  readonly helpText: string
  readonly parameters: readonly Param[]
  readonly outputs: readonly Output[]
}

export interface Provider {
  readonly id: string
  readonly name: string
  readonly algorithms: readonly Algorithm[]
}

export interface Registry {
  readonly qgisVersion: string
  readonly providers: readonly Provider[]
}

export interface GroupInfo {
  readonly name: string
  readonly count: number
}

export const MARKER = "__GEOCODE_REGISTRY_JSON__"

/**
 * The export script.
 *
 * **Its output is English as a property of HOW IT RUNS, not a setting** — and
 * that property is load-bearing (§4.11). The bare application constructed here
 * installs no interface translation, so every text the framework hands back
 * falls through to its source string, which is English. Any change that routes
 * this export through the full application startup silently switches the whole
 * catalog to the user's interface language — breaking the model's accuracy and
 * the documentation deep-links derived from display names.
 *
 * Three providers, exactly (§4.11 and a product decision): the official trio
 * shipped with QGIS. Installs also carry point-cloud and 3d providers; their
 * exclusion is deliberate scope, not an oversight.
 *
 * `ensure_ascii=False` emits the text raw rather than escaped, which is why
 * the subprocess-environment encoding constraint (§4.13) matters here: an
 * encoding fault corrupts the catalog body itself.
 *
 * Teardown runs BEFORE the marker is printed, so its chatter lands ahead of
 * the result line where the last-occurrence extractor ignores it; the hard
 * exit then skips the interpreter's own teardown noise (§4.13).
 */
export const EXPORT_SCRIPT = `
import faulthandler
faulthandler.enable()
import json, os, sys, io
from contextlib import redirect_stdout
from qgis.core import QgsApplication, QgsProcessingParameterDefinition
from processing.core.Processing import Processing
import processing

ALLOWED = {"native", "gdal", "qgis"}

qgs = QgsApplication([], False)
qgs.initQgis()
Processing.initialize()

registry = QgsApplication.processingRegistry()
result = {"qgisVersion": "", "providers": []}

try:
    from qgis.core import Qgis
    result["qgisVersion"] = Qgis.version() if hasattr(Qgis, "version") else Qgis.QGIS_VERSION
except Exception:
    pass

for prov in registry.providers():
    if prov.id() not in ALLOWED:
        continue
    p = {"id": prov.id(), "name": prov.name(), "algorithms": []}
    for algo in prov.algorithms():
        # The full help text comes from the help printer, captured. It is the
        # QGIS-maintained authority and is kept verbatim downstream (§4.11).
        buf = io.StringIO()
        with redirect_stdout(buf):
            processing.algorithmHelp(algo.id())
        help_text = buf.getvalue().strip()

        a = {
            "id": algo.id(),
            "name": algo.displayName(),
            "group": algo.group() or "Ungrouped",
            "description": algo.shortHelpString(),
            "helpText": help_text,
            "parameters": [],
            "outputs": [],
        }
        for param in algo.parameterDefinitions():
            dv = param.defaultValue()
            options = []
            try:
                if hasattr(param, "options"):
                    raw_options = param.options()
                    if raw_options is not None:
                        options = [str(x) for x in raw_options]
            except Exception:
                options = []
            a["parameters"].append({
                "name": param.name(),
                "description": param.description(),
                "type": param.type(),
                "defaultValue": str(dv) if dv is not None else None,
                "options": options,
                "optional": bool(param.flags() & QgsProcessingParameterDefinition.Flag.FlagOptional),
            })
        for out in algo.outputDefinitions():
            a["outputs"].append({
                "name": out.name(),
                "description": out.description(),
                "type": out.type(),
            })
        p["algorithms"].append(a)
    result["providers"].append(p)

qgs.exitQgis()
print("${MARKER}" + json.dumps(result, ensure_ascii=False))
sys.stdout.flush()
os._exit(0)
`

/**
 * Our own script with fully known behaviour: a fixed total clock (§8.4).
 * Generous, because the first build on a cold machine pays QGIS
 * initialisation plus one help rendering per algorithm.
 */
const TOTAL = "120 seconds"

export type BuildOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

export interface Interface {
  /**
   * Export the catalog for a verified environment and keep it in memory.
   *
   * Runs in the round fiber, under the round's token: a new round interrupts
   * the build (阶段依附, §4.8) and Status discards any late commit (代际).
   */
  readonly build: (environment: Environment) => Effect.Effect<BuildOutcome>
  /**
   * Drop whatever is held. Called by the lifecycle at the start of every
   * round: the catalog belongs to the verification that produced it (§4.8).
   */
  readonly invalidate: () => Effect.Effect<void>
  /** Deduplicated groups across providers, with counts, in stable order. */
  readonly groups: () => Effect.Effect<readonly GroupInfo[]>
  /** Every algorithm in a group, across providers, in stable order. */
  readonly inGroup: (group: string) => Effect.Effect<readonly Algorithm[]>
  /** Lookup by id, accepting both `native:buffer` and the short `buffer` (§4.11). */
  readonly get: (id: string) => Effect.Effect<Algorithm | undefined>
  /** Fuzzy search over ids and display names, by relevance. */
  readonly search: (query: string, limit?: number) => Effect.Effect<readonly Algorithm[]>
  /** Nearest candidates for an input that failed to match (§4.11). */
  readonly suggest: (input: string, kind: "group" | "algorithm", limit?: number) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/QgisCatalog") {}

function stripPrefix(id: string): string {
  const index = id.indexOf(":")
  return index >= 0 ? id.slice(index + 1) : id
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runtime = yield* GeoRuntime.Service
    const held = yield* Ref.make<Registry | undefined>(undefined)

    const build = (environment: Environment) =>
      Effect.gen(function* () {
        const result = yield* runtime
          .run({
            command: environment.python,
            args: ["-c", QgisBootstrap.wrapInline(EXPORT_SCRIPT, environment.dllDirectories)],
            env: environment.env,
            // The dump is megabytes of help text — 1.4MB measured on a real
            // 3.44 install — and grows with every QGIS release. This is the
            // §3.2 case of a call whose output is legitimately large: the cap
            // is raised explicitly rather than trusting the default's headroom,
            // because hitting it does not fail loudly, it truncates the marker
            // line and surfaces as a mysterious "no marker" error.
            delivery: { mode: "collect", limit: 32 * 1024 * 1024 },
            clocks: { total: TOTAL },
            label: "qgis:catalog",
          })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed<GeoRuntime.Result>({
                code: null,
                reason: "crash",
                stdout: "",
                stderr: error.message.split("\n")[0] ?? error.message,
                durationMs: 0,
                truncated: false,
                drainIncomplete: false,
              }),
            ),
          )

        const extracted = GeoOutput.extractMarked(result.stdout, MARKER)
        if (!extracted.ok) {
          const detail =
            result.reason === "timeout"
              ? `catalog export exceeded ${TOTAL}`
              : GeoOutput.truncate([result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n"), 4_000)
                  .text || "(no output at all)"
          return { ok: false as const, error: detail }
        }

        const registry = extracted.value as Registry
        yield* Ref.set(held, registry)
        return { ok: true as const }
      })

    const invalidate = () => Ref.set(held, undefined)

    // Queries answer from what is held and never trigger a build: WHEN to
    // build belongs to the lifecycle. An empty answer here pairs with a shut
    // gate (§4.9), which callers consult first.
    const groups = () =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return []
        const counts = new Map<string, number>()
        for (const provider of registry.providers) {
          for (const algorithm of provider.algorithms) {
            const group = algorithm.group || "(ungrouped)"
            counts.set(group, (counts.get(group) ?? 0) + 1)
          }
        }
        return Array.from(counts.entries(), ([name, count]) => ({ name, count })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      })

    const inGroup = (group: string) =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return []
        return registry.providers
          .flatMap((provider) => provider.algorithms.filter((algorithm) => algorithm.group === group))
          .sort((a, b) => a.name.localeCompare(b.name))
      })

    const get = (id: string) =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return undefined
        const all = registry.providers.flatMap((provider) => provider.algorithms)
        // Exact id first; the short form only as a fallback, so an exact match
        // can never be shadowed by a same-named algorithm in another provider.
        const exact = all.find((algorithm) => algorithm.id === id)
        if (exact) return exact
        const short = stripPrefix(id)
        return all.find((algorithm) => stripPrefix(algorithm.id) === short)
      })

    const search = (query: string, limit = 10) =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return []
        const targets = registry.providers.flatMap((provider) =>
          provider.algorithms.map((algorithm) => ({ algorithm, target: `${algorithm.id} ${algorithm.name}` })),
        )
        return fuzzysort
          .go(query, targets, { key: "target", limit, threshold: -10000 })
          .map((result) => result.obj.algorithm)
      })

    const suggest = (input: string, kind: "group" | "algorithm", limit = 3) =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return []
        const candidates =
          kind === "group"
            ? [...new Set(registry.providers.flatMap((p) => p.algorithms.map((a) => a.group || "(ungrouped)")))]
            : registry.providers.flatMap((p) => p.algorithms.map((a) => a.id))
        return fuzzysort.go(input, candidates, { limit, threshold: -10000 }).map((result) => result.target)
      })

    return Service.of({ build, invalidate, groups, inGroup, get, search, suggest })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [GeoRuntime.node] })
