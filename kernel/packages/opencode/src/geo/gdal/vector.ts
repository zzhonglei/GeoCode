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
 * Content and pages arrive in web mercator whatever the source was, so the front end performs no projection
 * arithmetic at all. --- */

/**
 * The interface's own rendering limit; both ends must carry the same number (§11). Checked here and not only in
 * the front end, because the data plane is open to any caller (§7.4).
 */
export const MAX_INLINE_FEATURES = 5_000

const TARGET_CRS = "EPSG:3857"

/** A conversion reads and rewrites the whole layer; a header read does not. */
const CONVERT_TIMEOUT = "120 seconds"

/** An entry is every feature of a layer, so this buys page turns without re-parsing at a bounded cost (§7.6). */
const MEMORY_LAYERS = 4

export interface Meta {
  readonly name: string
  readonly featureCount: number
  readonly geometryTypes: readonly string[]
  readonly properties: readonly string[]
  /** The SOURCE system; content and pages are web mercator whatever this says. */
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

/** For the fallback path, where the summary failed and the facts have to come from the features themselves. */
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
    // The document has already been reprojected, so the source system is not in it.
    projection: undefined,
  }
}

/** The layer name comes from the file rather than from us, and may hold a quote. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

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

/** Holds the memory layer its page path reads from, so the parsed features outlive the call that produced them. */
export const make = (): Effect.Effect<Layers, never, never> =>
  Effect.sync(() => {
    // Insertion order is the recency order: re-inserting on read moves an entry to the end, so the first key is oldest.
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
        // The fallback converts, and keeps what it produced, so the content phase behind it finds the work already
        // done rather than paying for the same conversion twice (§7.4).
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
        // A summary that succeeded refuses before any conversion; one that failed has already converted, inside `meta`.
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

        // 1. Already parsed: a page turn on an open layer spawns nothing and reads no artifact, only the key's stat.
        const remembered = recall(key)
        if (remembered) {
          return { features: remembered.slice(offset, offset + limit), total: remembered.length, offset, limit }
        }

        // 2. Converted earlier this session; parsing megabytes is worth doing once, so what comes out is kept.
        if (existsSync(target)) {
          const features = parseFeatures(readFileSync(target, "utf8"))
          if (features) {
            remember(key, features)
            return { features: features.slice(offset, offset + limit), total: features.length, offset, limit }
          }
        }

        // 3. Neither, and the layer may be too large to convert whole — ask the engine for this window only (§7.4).
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
