export * as MachineLoader from "./loader"

import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ConfigPaths } from "@/config/paths"
import { ConfigParse } from "@/config/parse"
import { MachineSchema } from "./schema"

/* --- GeoCode: reading `machine.json` (docs/GEOKERNEL.md §3.1). Change is judged on a block's canonicalized VALUE
 * rather than on the file text, so a format-on-save does not cost a tens-of-seconds environment re-probe. --- */

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
  /** Where the syntax error is, or the decode error's own text when there is no position to report. */
  readonly message: string
}

export type Loaded =
  | { readonly ok: true; readonly value: MachineSchema.Machine }
  | { readonly ok: false; readonly failure: ParseFailure }

/** A file that will not parse fails the whole load rather than falling back: stale values would leave the file and
 * the system's behaviour disagreeing (§3.1). */
export async function load(): Promise<Loaded> {
  let merged: MachineSchema.Machine = MachineSchema.EMPTY
  for (const file of files()) {
    const read = await readOne(file)
    if (!read.ok) return read
    // Later files win per key (§3.1): both forms coexisting is a user mistake, but it must land on one result.
    merged = { ...merged, ...read.value }
  }
  return { ok: true as const, value: merged }
}

/**
 * One retry, because a just-saved file can still be held open for a few milliseconds by a Windows indexer or
 * antivirus. The watcher path logs and ignores a throw, so without it a dropped read leaves the previous
 * configuration running with nothing on screen saying so.
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
  // A leading U+FEFF makes jsonc-parser report InvalidSymbol at offset 0, and Windows Notepad writes one by default.
  const stripped = text.replace(/^\uFEFF/, "")
  if (!stripped.trim()) return { ok: true, value: MachineSchema.EMPTY }
  try {
    const data = ConfigParse.jsonc(stripped, file)
    // Unknown top-level keys are dropped, not rejected, so one mistyped key (`gdal1`) disables only itself (§3.1).
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

/**
 * Positions only, never `data.message` itself: the parser prefixes its report with a `--- JSONC Input ---` dump of
 * the whole file and echoes each offending source line, and `config-error` carries this string onto the interface.
 * Unknown keys are ignored (§3.1), so nothing bounds what a user keeps in the file.
 */
function positionOf(err: unknown): string | undefined {
  const data = (err as { data?: { message?: unknown } } | null | undefined)?.data
  if (typeof data?.message !== "string") return undefined
  const positions = data.message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bat line \d+, column \d+$/.test(line))
  return positions.length > 0 ? positions.join("; ") : undefined
}

/** Seed an empty template on first run so a new user has a file to edit. Never overwrites either existing form. */
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

/** Stable identity of a block's value, for artifacts to bind to (§3.1): the GDAL preview cache keys on it. */
export function fingerprint(block: MachineSchema.BlockName, value: unknown): string {
  return `${block}:${createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16)}`
}

/**
 * A distinguished value rather than the last good one, so artifacts do not stay bound to a configuration the system
 * can no longer read; fixing the file restores the previous fingerprint and revalidates what was cached (§3.1).
 */
export function unparsableFingerprint(block: MachineSchema.BlockName): string {
  return `${block}:unparsable`
}
