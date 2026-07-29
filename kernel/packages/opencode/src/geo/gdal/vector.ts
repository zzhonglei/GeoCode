export * as GdalVector from "./vector"

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { GeoRuntime } from "../runtime"
import { GdalCache } from "./cache"
import { GdalInspector } from "./inspector"
import type { GdalTypes } from "./types"

/* --- GeoCode: producing vector data for the interface (docs/GEOKERNEL.md §7.4).
 *
 * Two phases, because they cost different amounts. The metadata phase reads a
 * header and answers in milliseconds, which is what lets the interface draw a
 * skeleton immediately; the content phase converts the whole layer and costs
 * what the file costs. Nothing here makes the first wait for the second.
 *
 * **Everything is delivered in web mercator.** The front end performs no
 * projection arithmetic at all — that is the promise this module makes, and it
 * is what keeps the front end simple enough to stay correct. --- */

/**
 * The most features handed over in one piece.
 *
 * Not a guess: it is the interface's own rendering limit. Above it the map does
 * not mount and the table view takes over, so a full delivery would be work
 * nobody uses — and the same number on both sides is what keeps the two halves
 * consistent.
 *
 * **The check belongs here, not only in the front end.** The data plane is an
 * open endpoint: any caller can ask, and one oversized answer is enough to take
 * a renderer down. The old build enforced this in the front end alone, which
 * left every other caller unprotected (§7.4).
 *
 * Raising it means raising the interface's limit too, or the front end starts
 * receiving what it has already decided it will not draw.
 */
export const MAX_INLINE_FEATURES = 5_000

/** Web mercator: what every consumer of this module receives, whatever the source was. */
const TARGET_CRS = "EPSG:3857"

/** A conversion reads and rewrites the whole layer; a header read does not. */
const CONVERT_TIMEOUT = "120 seconds"

/**
 * Parsed layers held in memory.
 *
 * Small on purpose. An entry is every feature of a layer, so this trades a
 * bounded amount of memory against re-parsing megabytes of JSON on each page
 * turn — and a user has a handful of layers open, not hundreds.
 */
const MEMORY_LAYERS = 4

export interface Meta {
  readonly name: string
  readonly featureCount: number
  readonly geometryTypes: readonly string[]
  readonly properties: readonly string[]
  /**
   * The SOURCE coordinate system, for the reader's information.
   *
   * NOT the coordinate system of anything this module returns — content and
   * pages are always web mercator. The two are different facts and reporting
   * the delivered one here would hide the only interesting thing about it.
   */
  readonly projection?: string
}

export interface Page {
  readonly features: readonly unknown[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

export class GdalVectorError extends Error {
  constructor(
    message: string,
    readonly kind: "too-many-features" | "conversion-failed",
    readonly featureCount?: number,
  ) {
    super(message)
    this.name = "GdalVectorError"
  }
}

/** Features out of a GeoJSON document, or undefined when it is not one. */
export function parseFeatures(document: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(document)
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed.features)) return parsed.features
    if (parsed?.type === "Feature") return [parsed]
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Metadata read out of a converted document.
 *
 * The fallback path's source of truth: when the header summary fails there is
 * no layer declaration to read, so the facts come from the features themselves.
 * Scanning is affordable here precisely because the conversion already paid to
 * produce them.
 */
export function metaFromContent(name: string, document: string): Meta {
  const features = parseFeatures(document) ?? []
  const geometryTypes = new Set<string>()
  const properties = new Set<string>()
  for (const feature of features as { geometry?: { type?: unknown }; properties?: object }[]) {
    if (typeof feature?.geometry?.type === "string") geometryTypes.add(feature.geometry.type)
    for (const key of Object.keys(feature?.properties ?? {})) properties.add(key)
  }
  return {
    name,
    featureCount: features.length,
    geometryTypes: [...geometryTypes],
    properties: [...properties],
    // Everything reaching here has been reprojected already, so the source
    // system is no longer recoverable from the document.
    projection: undefined,
  }
}

/** Escape a layer name for an SQL identifier. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** The query one page of features comes from. */
export function pageQuery(layer: string, offset: number, limit: number): string {
  return `SELECT * FROM ${quoteIdentifier(layer)} LIMIT ${Math.max(0, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`
}

interface Layers {
  readonly meta: (environment: GdalTypes.Environment, file: string) => Effect.Effect<Meta, Error, GeoRuntime.Service>
  readonly content: (
    environment: GdalTypes.Environment,
    file: string,
  ) => Effect.Effect<string, Error, GeoRuntime.Service>
  readonly page: (
    environment: GdalTypes.Environment,
    file: string,
    offset: number,
    limit: number,
  ) => Effect.Effect<Page, Error, GeoRuntime.Service>
}

/**
 * The vector pipeline, holding the memory layer its page path reads from.
 *
 * Constructed rather than free functions because the parsed-layer cache has to
 * outlive individual calls — that is the entire point of it — while staying
 * scoped to the module rather than to the process.
 */
export const make = (): Effect.Effect<Layers, never, never> =>
  Effect.sync(() => {
    // Insertion order IS the recency order: re-inserting on read moves an entry
    // to the end, so eviction is the first key. No timestamps to keep correct.
    const parsedLayers = new Map<string, unknown[]>()

    const remember = (key: string, features: unknown[]) => {
      parsedLayers.delete(key)
      parsedLayers.set(key, features)
      while (parsedLayers.size > MEMORY_LAYERS) {
        const oldest = parsedLayers.keys().next().value
        if (oldest === undefined) break
        parsedLayers.delete(oldest)
      }
    }

    const recall = (key: string) => {
      const features = parsedLayers.get(key)
      if (features) remember(key, features)
      return features
    }

    const convert = (environment: GdalTypes.Environment, file: string, args: readonly string[], label: string) =>
      Effect.gen(function* () {
        const runtime = yield* GeoRuntime.Service
        const result = yield* runtime
          .run({
            command: environment.tools.ogr2ogr,
            args: [...args, "/vsistdout/", file],
            env: environment.env,
            delivery: { mode: "collect" },
            clocks: { total: CONVERT_TIMEOUT },
            label,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new GdalVectorError(`the conversion could not be started: ${error.message}`, "conversion-failed"),
            ),
          )
        if (result.code !== 0 || !result.stdout.trim()) {
          return yield* Effect.fail(
            new GdalVectorError(`the layer could not be converted to ${TARGET_CRS}`, "conversion-failed"),
          )
        }
        return result.stdout
      })

    /** Convert the whole layer to web mercator and keep it. */
    const produceContent = (environment: GdalTypes.Environment, file: string, target: string) =>
      Effect.gen(function* () {
        const document = yield* convert(
          environment,
          file,
          ["-f", "GeoJSON", "-t_srs", TARGET_CRS],
          "gdal:vector-convert",
        )
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, document, "utf8")
        return document
      })

    const paths = (environment: GdalTypes.Environment, file: string) => {
      const key = GdalCache.key(GdalCache.describe(file), environment.fingerprint)
      return { key, content: path.join(GdalCache.directory("vector", key), "content.geojson") }
    }

    const meta: Layers["meta"] = (environment, file) =>
      GdalInspector.inspectVector(environment, file).pipe(
        Effect.map(
          (info): Meta => ({
            name: info.name,
            featureCount: info.featureCount,
            geometryTypes: info.geometryTypes,
            properties: info.properties,
            projection: info.projection,
          }),
        ),
        // The summary can fail on formats whose header carries no counts. The
        // fallback converts, which is expensive — so it KEEPS what it produced,
        // and the content phase behind it finds the work already done rather
        // than paying for the same conversion twice (§7.4).
        Effect.catch(() =>
          Effect.gen(function* () {
            const { content } = paths(environment, file)
            const document = yield* produceContent(environment, file, content)
            return metaFromContent(path.basename(file, path.extname(file)), document)
          }),
        ),
      )

    const content: Layers["content"] = (environment, file) =>
      Effect.gen(function* () {
        const { content: target } = paths(environment, file)
        // The count is already known from the header, so the refusal costs
        // nothing — no conversion is started for a layer that will be refused.
        const summary = yield* meta(environment, file)
        if (summary.featureCount > MAX_INLINE_FEATURES) {
          return yield* Effect.fail(
            new GdalVectorError(
              `${summary.featureCount} features is more than the ${MAX_INLINE_FEATURES} deliverable in one piece; read it by page instead`,
              "too-many-features",
              summary.featureCount,
            ),
          )
        }
        if (existsSync(target)) {
          const cached = readFileSync(target, "utf8")
          if (cached.trim()) return cached
        }
        return yield* produceContent(environment, file, target)
      })

    const page: Layers["page"] = (environment, file, offset, limit) =>
      Effect.gen(function* () {
        const { key, content: target } = paths(environment, file)

        // 1. Already parsed. Page turns on an open layer never touch the disk.
        const remembered = recall(key)
        if (remembered) {
          return { features: remembered.slice(offset, offset + limit), total: remembered.length, offset, limit }
        }

        // 2. Converted earlier this session. Parsing megabytes is worth doing
        //    once, so what comes out of it is kept.
        if (existsSync(target)) {
          const features = parseFeatures(readFileSync(target, "utf8"))
          if (features) {
            remember(key, features)
            return { features: features.slice(offset, offset + limit), total: features.length, offset, limit }
          }
        }

        // 3. Neither, and the layer may be far too large to convert whole.
        //    Asking the engine for just this window is what lets a user page
        //    through a file that will never fit in one delivery (§7.4).
        const summary = yield* meta(environment, file)
        const document = yield* convert(
          environment,
          file,
          ["-f", "GeoJSON", "-t_srs", TARGET_CRS, "-sql", pageQuery(summary.name, offset, limit)],
          "gdal:vector-page",
        )
        return { features: parseFeatures(document) ?? [], total: summary.featureCount, offset, limit }
      })

    return { meta, content, page }
  })
