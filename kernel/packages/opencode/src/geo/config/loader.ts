export * as MachineLoader from "./loader"

import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ConfigPaths } from "@/config/paths"
import { ConfigParse } from "@/config/parse"
import { MachineSchema } from "./schema"

/* --- GeoCode: reading `machine.json` (docs/GEOKERNEL.md §3.1).
 *
 * The whole module exists to answer one question correctly: "did a block's
 * VALUE change?" — not "did the file change?". Editors reformat, reorder keys
 * and rewrite comments on every save; treating those as changes would kick off
 * a tens-of-seconds environment re-probe each time the user hits save. --- */

/** File stem; both `.json` and `.jsonc` are accepted, mirroring `geocode.json(c)`. */
const NAME = "machine"

/** First-run template. Intentionally an empty object: configuration guidance
 * lives in the in-app status surfaces, not in comments inside the file, so the
 * user is never editing around text we wrote. */
const TEMPLATE = "{}\n"

export function files() {
  return ConfigPaths.fileInDirectory(Global.Path.config, NAME)
}

export function directory() {
  return Global.Path.config
}

/** True when `name` is one of the files we care about within the config dir. */
export function isMachineFile(name: string) {
  return name === `${NAME}.json` || name === `${NAME}.jsonc`
}

export type ParseFailure = {
  readonly file: string
  /** Human-readable location of the syntax error, as produced by the kernel's JSONC parser. */
  readonly message: string
}

export type Loaded =
  | { readonly ok: true; readonly value: MachineSchema.Machine }
  | { readonly ok: false; readonly failure: ParseFailure }

/**
 * Read and merge every present config file.
 *
 * A syntax error anywhere fails the WHOLE load rather than falling back to the
 * last good value: keeping stale values alive would make the file's contents
 * and the system's behaviour disagree, and a syntax error is something the user
 * should learn about at the moment they save (§3.1).
 */
export async function load(): Promise<Loaded> {
  let merged: MachineSchema.Machine = MachineSchema.EMPTY
  for (const file of files()) {
    const read = await readOne(file)
    if (!read.ok) return read
    // Later files win per key. Both forms coexisting is a user mistake rather
    // than a supported layout, but it must resolve deterministically instead of
    // depending on which one the loop happened to see last.
    merged = { ...merged, ...read.value }
  }
  return { ok: true as const, value: merged }
}

/**
 * Read the file, tolerating one transient failure.
 *
 * On Windows a save is regularly followed by an antivirus or indexer holding
 * the file open for a few milliseconds, and the read lands in that window with
 * EPERM/EBUSY. Without a retry the whole edit is dropped — logged and
 * swallowed upstream, with the system still running the previous
 * configuration and nothing on screen saying so. One short retry covers the
 * lock window; a failure that survives it is a real one and propagates.
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
  // Windows Notepad writes UTF-8 with a BOM by default and the JSONC parser
  // chokes on the leading U+FEFF. Our users hand-edit this file on Windows.
  const stripped = text.replace(/^\uFEFF/, "")
  if (!stripped.trim()) return { ok: true, value: MachineSchema.EMPTY }
  try {
    const data = ConfigParse.jsonc(stripped, file)
    // Decoded directly rather than through ConfigParse.schema: that helper
    // REJECTS unknown top-level keys, while this file must ignore them so one
    // mistyped key (`gdal1`) disables only itself instead of taking down the
    // valid blocks beside it (§3.1, "未知键忽略").
    const value = Schema.decodeUnknownSync(MachineSchema.Machine)(data)
    return { ok: true, value }
  } catch (err) {
    return { ok: false, failure: { file, message: messageOf(err) } }
  }
}

function messageOf(err: unknown) {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Seed an empty template on first run so a new user has a file to edit rather
 * than an empty directory. Never overwrites either existing form.
 */
export async function ensureTemplate(): Promise<void> {
  for (const existing of files()) {
    if (await exists(existing)) return
  }
  // `wx` = exclusive create: two bootstraps racing to seed cannot clobber each
  // other, and neither can clobber a file written in between.
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

/**
 * Marks a block that is not present at all.
 *
 * Not valid JSON, so it can never equal the canonical form of a real value —
 * including `null`, which the user can write and which must be told apart from
 * "the key is missing".
 */
const ABSENT = "<absent>"

/**
 * Canonical form of a block value: key order removed, so that a reformatting
 * save produces a byte-identical string and therefore no change signal.
 */
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

/**
 * Stable identity of a block's current value, for downstream artifacts to bind
 * to the configuration that produced them (§3.1). The data-plane cache key uses
 * it, so changing the GDAL block invalidates GDAL artifacts while leaving the
 * rest untouched.
 */
export function fingerprint(block: MachineSchema.BlockName, value: unknown): string {
  return `${block}:${createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16)}`
}

/**
 * The fingerprint a block carries while the file cannot be parsed.
 *
 * A distinguished value rather than the last good one: artifacts must not stay
 * bound to a configuration the system can no longer read. It costs nothing —
 * every block is in an error state during this window so no capability is
 * running to produce new artifacts, and once the syntax error is fixed the
 * fingerprint returns to its previous value, making already-cached artifacts
 * valid again. Block-scoped so two blocks can never collide on it.
 */
export function unparsableFingerprint(block: MachineSchema.BlockName): string {
  return `${block}:unparsable`
}
