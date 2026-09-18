export * as MachineLoader from "./loader"

import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ConfigPaths } from "@/config/paths"
import { ConfigParse } from "@/config/parse"
import { MachineSchema } from "./schema"

/* --- GeoCode: reading and canonicalizing `machine.json` (docs/GEOKERNEL.md §3.1). --- */

const NAME = "machine"

const TEMPLATE = "{}\n"

export function files() {
  return ConfigPaths.fileInDirectory(Global.Path.config, NAME)
}

export function directory() {
  return Global.Path.config
}

export function isMachineFile(name: string) {
  return name === `${NAME}.json` || name === `${NAME}.jsonc`
}

export type ParseFailure = {
  readonly file: string
  readonly message: string
}

export type Loaded =
  | { readonly ok: true; readonly value: MachineSchema.Machine }
  | { readonly ok: false; readonly failure: ParseFailure }

/** An unparsable file fails the whole load rather than falling back to stale values (docs/GEOKERNEL.md §3.1). */
export async function load(): Promise<Loaded> {
  let merged: MachineSchema.Machine = MachineSchema.EMPTY
  for (const file of files()) {
    const read = await readOne(file)
    if (!read.ok) return read
    merged = { ...merged, ...read.value }
  }
  return { ok: true as const, value: merged }
}

/**
 * One retry, because a just-saved file can still be held open for a few milliseconds by a Windows indexer or
 * antivirus, and the watcher path only logs a failed read.
 */
async function readFileTolerantly(file: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(file, "utf-8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return undefined
      if (attempt >= 1) throw err
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
}

async function readOne(file: string): Promise<Loaded> {
  const text = await readFileTolerantly(file)
  if (text === undefined) return { ok: true, value: MachineSchema.EMPTY }
  // jsonc-parser rejects a leading BOM as InvalidSymbol at offset 0.
  const stripped = text.replace(/^\uFEFF/, "")
  if (!stripped.trim()) return { ok: true, value: MachineSchema.EMPTY }
  try {
    const data = ConfigParse.jsonc(stripped, file)
    // Unknown top-level keys are dropped, not rejected, so one mistyped key (`gdal1`) disables only itself.
    const value = Schema.decodeUnknownSync(MachineSchema.Machine)(data)
    return { ok: true, value }
  } catch (err) {
    return { ok: false, failure: { file, message: messageOf(err) } }
  }
}

function messageOf(err: unknown) {
  // The fallback is the last resort: on a JSONC failure `err.message` is the bare class name `ConfigJsonError`.
  return positionOf(err) ?? (err instanceof Error ? err.message : String(err))
}

/** Positions only: `data.message` dumps the whole file, and this string reaches the interface as `config-error`. */
function positionOf(err: unknown): string | undefined {
  const data = (err as { data?: { message?: unknown } } | null | undefined)?.data
  if (typeof data?.message !== "string") return undefined
  const positions = data.message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bat line \d+, column \d+$/.test(line))
  return positions.length > 0 ? positions.join("; ") : undefined
}

export async function ensureTemplate(): Promise<void> {
  for (const existing of files()) {
    if (await exists(existing)) return
  }
  // Exclusive create, because the check above and the write below are not atomic against a concurrent bootstrap.
  await fs
    .writeFile(path.join(Global.Path.config, `${NAME}.json`), TEMPLATE, { encoding: "utf-8", flag: "wx" })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return
      throw err
    })
}

async function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

/** Not valid JSON, so it never collides with a real value — including the `null` a user can write for a key. */
const ABSENT = "<absent>"

/** Key order removed, so a reformatting save produces the same string and therefore no change signal. */
export function canonical(value: unknown): string {
  if (value === undefined) return ABSENT
  return JSON.stringify(sort(value))
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** GDAL cache keys are built on this, so it must change only when the block's value does. */
export function fingerprint(block: MachineSchema.BlockName, value: unknown): string {
  return `${block}:${createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16)}`
}

/** Never the last good fingerprint, so nothing stays bound to a configuration that no longer parses. */
export function unparsableFingerprint(block: MachineSchema.BlockName): string {
  return `${block}:unparsable`
}
