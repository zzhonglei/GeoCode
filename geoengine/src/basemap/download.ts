import { createHash } from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"

/**
 * How long a downloaded file is used before it is downloaded again, and how much of them is kept. An older one is
 * still used while it cannot be downloaded again, as offline in the field: the areas seen before stay on the map.
 */
export const FRESH_MS = 7 * 24 * 60 * 60 * 1000
export const KEPT = 1024 ** 3
/** The cache is trimmed after this many downloads, and once as the engine starts. */
const TRIM_EVERY = 500
/** A file still being written after this was left by an engine that stopped. */
const ABANDONED_MS = 60 * 60 * 1000
/** Requests to one server at a time, as a browser makes. */
const PER_HOST = 6
const TIMEOUT_MS = 30_000

/** A file of an online basemap: its bytes, or null where the server has none, as for a tile beyond its data. */
export type Download = Uint8Array | null

export interface Options {
  /** Names the file in the cache in place of the address, for one that carries a key. */
  readonly identity?: string
  /** A tile, which a server may lack: none is an answer then, kept as one, where for any other file it is a failure. */
  readonly tile?: boolean
  /** Whether the bytes are what was asked for; ones that are not fail, and are not kept. */
  readonly check?: (bytes: Uint8Array) => boolean
}

export interface Downloader {
  /** `url`'s file, from the cache while it is fresh, or while it cannot be downloaded again. */
  readonly get: (url: string, signal: AbortSignal, options?: Options) => Promise<Download>
  /** Leaves no more than KEPT bytes; the files downloaded first go first. */
  readonly trim: () => Promise<void>
}

/** Runs no more than `size` at once; the rest wait their turn. */
const limiter = (size: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    // A finished run hands its place to the next waiting, so none enters past it.
    if (active < size) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/**
 * Downloads the files of online basemaps into `folder`, each request carrying `agent` as its User-Agent, as
 * OpenStreetMap's tile policy asks. Through the proxy the environment names when the engine runs with
 * NODE_USE_ENV_PROXY, as desktop/packages/electron/geocode/geoengine.mjs starts it.
 */
export const downloader = (folder: string, agent: string): Downloader => {
  const hosts = new Map<string, ReturnType<typeof limiter>>()
  let downloads = 0

  const fileOf = (identity: string) => {
    const hash = createHash("sha1").update(identity).digest("hex")
    return path.join(folder, hash.slice(0, 2), hash)
  }

  // An empty file is a tile the server lacks; for any other file it stands for nothing.
  const cached = async (file: string, tile: boolean): Promise<{ bytes: Download; fresh: boolean } | undefined> => {
    const stat = await fsp.stat(file).catch(() => undefined)
    if (!stat) return undefined
    const bytes = await fsp.readFile(file).catch(() => undefined)
    if (!bytes || (!bytes.length && !tile)) return undefined
    return { bytes: bytes.length ? new Uint8Array(bytes) : null, fresh: Date.now() - stat.mtimeMs <= FRESH_MS }
  }

  // A cache that cannot be written is only slower.
  const keep = async (file: string, bytes: Download) => {
    const part = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.part`
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(part, bytes ?? new Uint8Array())
      await fsp.rename(part, file)
    } catch {
      await fsp.rm(part, { force: true }).catch(() => {})
    }
  }

  const fetched = async (url: string, signal: AbortSignal, tile: boolean): Promise<Download> => {
    const host = new URL(url).host
    const limit = hosts.get(host) ?? limiter(PER_HOST)
    hosts.set(host, limit)
    return limit(async () => {
      const response = await fetch(url, {
        headers: { "user-agent": agent },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      })
      if (tile && (response.status === 404 || response.status === 204)) return null
      if (!response.ok) throw new Error(`${host} answered ${response.status}`)
      // A login page of a campus or hotel network, or a proxy's refusal, answers 200 with a web page: kept, it would
      // stand for the file for a week after the network lets the user through.
      if (response.headers.get("content-type")?.startsWith("text/html")) throw new Error(`${host} answered a web page`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length) return bytes
      if (tile) return null
      throw new Error(`${host} answered nothing`)
    })
  }

  const trim = async () => {
    const files: { file: string; size: number; time: number }[] = []
    for (const shard of await fsp.readdir(folder).catch(() => [])) {
      for (const name of await fsp.readdir(path.join(folder, shard)).catch(() => [])) {
        const file = path.join(folder, shard, name)
        const stat = await fsp.stat(file).catch(() => undefined)
        if (!stat?.isFile()) continue
        // One being read, or scanned by an antivirus on Windows, cannot go: the next trim takes it.
        if (!name.endsWith(".part")) files.push({ file, size: stat.size, time: stat.mtimeMs })
        else if (Date.now() - stat.mtimeMs > ABANDONED_MS) await fsp.rm(file, { force: true }).catch(() => {})
      }
    }
    let total = files.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of files.toSorted((a, b) => a.time - b.time)) {
      if (total <= KEPT) break
      const gone = await fsp.rm(entry.file, { force: true }).then(
        () => true,
        () => false,
      )
      if (gone) total -= entry.size
    }
  }

  const get = async (url: string, signal: AbortSignal, options: Options = {}) => {
    const file = fileOf(options.identity ?? url)
    const kept = await cached(file, options.tile ?? false)
    if (kept?.fresh) return kept.bytes
    let older = false
    const bytes = await fetched(url, signal, options.tile ?? false)
      .then((bytes) => {
        if (bytes && options.check && !options.check(bytes))
          throw new Error(`${new URL(url).host} answered something else`)
        return bytes
      })
      // An older copy rather than nothing; the next view asks the server again.
      .catch((error: unknown) => {
        if (!kept) throw error
        older = true
        return kept.bytes
      })
    if (older) return bytes
    await keep(file, bytes)
    if (++downloads % TRIM_EVERY === 0) void trim().catch(() => {})
    return bytes
  }

  return { get, trim }
}
