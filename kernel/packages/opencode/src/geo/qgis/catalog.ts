export * as QgisCatalog from "./catalog"

import { Context, Effect, Layer, Ref } from "effect"
import fuzzysort from "fuzzysort"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GeoRuntime } from "../runtime"
import { GeoOutput } from "../runtime/output"
import { QgisBootstrap } from "./bootstrap"
import type { Environment } from "./types"

/* --- GeoCode: the algorithm catalog, held in memory only; the lifecycle in ./index.ts decides when to build and
 * invalidate it (docs/GEOKERNEL.md §4.11). --- */

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
  /** Verbatim from QGIS; never trim or rewrite it (§4.11). */
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

export const UNGROUPED = "Ungrouped"

/**
 * The bare application built here installs no interface translation, so the framework's text falls through to its
 * English source strings; routing this through full application startup would localise the whole catalog instead.
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
            "group": algo.group() or "${UNGROUPED}",
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

/** A fixed total clock (§8.4): a cold build pays QGIS startup plus one help rendering per algorithm. */
const TOTAL = "120 seconds"

export type BuildOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * `ambiguous` carries the candidates the lookup declined to choose between; folding it into `missing` throws that set
 * away and leaves the caller to re-guess it (§4.11).
 */
export type Resolution =
  | { readonly kind: "found"; readonly algorithm: Algorithm }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "missing" }

export interface Interface {
  readonly build: (environment: Environment) => Effect.Effect<BuildOutcome>
  readonly invalidate: () => Effect.Effect<void>
  readonly groups: () => Effect.Effect<readonly GroupInfo[]>
  readonly inGroup: (group: string) => Effect.Effect<readonly Algorithm[]>
  /** Exact id, then folded id with or without prefix, then folded name; a tier matching several is ambiguous. */
  readonly resolve: (id: string) => Effect.Effect<Resolution>
  /** `resolve` for callers that only act on a hit; ambiguity reads as absence. */
  readonly get: (id: string) => Effect.Effect<Algorithm | undefined>
  readonly search: (query: string, limit?: number) => Effect.Effect<readonly Algorithm[]>
  readonly suggest: (input: string, kind: "group" | "algorithm", limit?: number) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@geocode/QgisCatalog") {}

function stripPrefix(id: string): string {
  const index = id.indexOf(":")
  return index >= 0 ? id.slice(index + 1) : id
}

/** Applied to both sides of a lookup. Latin-only, which holds only because the export is English. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
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
            // Help text grows with each release. Past the cap the run is usually not killed: the dump lands in one
            // burst, the marker at its front is dropped, and it surfaces as "no marker".
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

    // Queries never trigger a build; callers consult the gate first (§4.9).
    const groups = () =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return []
        const counts = new Map<string, number>()
        for (const provider of registry.providers) {
          for (const algorithm of provider.algorithms) {
            const group = algorithm.group || UNGROUPED
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
        const wanted = fold(group)
        if (!wanted) return []
        // The same `|| UNGROUPED` fallback as groups(), so every group it lists is found here.
        return registry.providers
          .flatMap((provider) =>
            provider.algorithms.filter((algorithm) => fold(algorithm.group || UNGROUPED) === wanted),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      })

    const resolve = (id: string): Effect.Effect<Resolution> =>
      Effect.gen(function* () {
        const registry = yield* Ref.get(held)
        if (!registry) return { kind: "missing" as const }
        const all = registry.providers.flatMap((provider) => provider.algorithms)
        // Below the full id a tier never picks among several matches: short ids and display names are shared by
        // algorithms with unrelated parameter sets, and the first match would run one the caller never asked for.
        const exact = all.find((algorithm) => algorithm.id === id)
        if (exact) return { kind: "found" as const, algorithm: exact }

        const wanted = new Set([fold(id), fold(stripPrefix(id))].filter((value) => value.length > 0))
        if (wanted.size === 0) return { kind: "missing" as const }

        const tier = (matched: readonly Algorithm[]): Resolution | undefined => {
          if (matched.length === 1) return { kind: "found", algorithm: matched[0]! }
          if (matched.length > 1) return { kind: "ambiguous", candidates: matched.map((item) => item.id) }
          return undefined
        }

        const byId = tier(
          all.filter((algorithm) => wanted.has(fold(algorithm.id)) || wanted.has(fold(stripPrefix(algorithm.id)))),
        )
        if (byId) return byId

        return tier(all.filter((algorithm) => wanted.has(fold(algorithm.name)))) ?? { kind: "missing" }
      })

    const get = (id: string) =>
      resolve(id).pipe(Effect.map((outcome) => (outcome.kind === "found" ? outcome.algorithm : undefined)))

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
            ? [...new Set(registry.providers.flatMap((p) => p.algorithms.map((a) => a.group || UNGROUPED)))]
            : registry.providers.flatMap((p) => p.algorithms.map((a) => a.id))
        return fuzzysort.go(input, candidates, { limit, threshold: -10000 }).map((result) => result.target)
      })

    return Service.of({ build, invalidate, groups, inGroup, resolve, get, search, suggest })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [GeoRuntime.node] })
