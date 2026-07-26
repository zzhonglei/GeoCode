export * as MachineSchema from "./schema"

import { Schema } from "effect"
import { optional } from "@opencode-ai/schema/schema"

/* --- GeoCode: the schema for `machine.json` — the description of THIS machine's
 * geographic environment (docs/PATHS.md §3.2, docs/GEOKERNEL.md §3.1).
 *
 * Deliberately tiny. Every field here is a place the user can get something
 * wrong, so the design buys back configurability with derivation instead:
 * `qgis` is a single *location hint* in any of five shapes rather than a
 * precise interpreter+prefix pair, because all five derive to the same result
 * (GEOKERNEL.md §4.2, and the tradeoff record in §12). --- */

/** One config block per capability domain. The block is the unit of change
 * dispatch, fingerprinting, and parse-failure blast radius (§3.1). */
export const BlockNames = ["qgis", "gee", "gdal"] as const
export type BlockName = (typeof BlockNames)[number]

/**
 * A location hint pointing anywhere inside a QGIS installation: the bundled
 * interpreter, the app bundle, the install root, the official launcher script,
 * or an intermediate directory within the install. All shapes resolve to the
 * same environment (§4.2).
 */
export const Qgis = Schema.String

/**
 * Both fields are required to run, but they are checked at opposite ends of the
 * dependency chain — the interpreter decides whether a script can run at all,
 * the project decides whether it can be authorized once running. Merging them
 * into one "incomplete" state would cost the guidance its precision (§5.2).
 */
export const Gee = Schema.Struct({
  python: optional(Schema.String),
  project: optional(Schema.String),
})
export interface Gee extends Schema.Schema.Type<typeof Gee> {}

/** Directory holding the GDAL command-line tools used by the data plane (§7.3). */
export const Gdal = Schema.String

export const Machine = Schema.Struct({
  $schema: optional(Schema.String),
  qgis: optional(Qgis),
  gee: optional(Gee),
  gdal: optional(Gdal),
})
export interface Machine extends Schema.Schema.Type<typeof Machine> {}

/** The value of a single block, keyed by block name. */
export type BlockValue<Name extends BlockName = BlockName> = Machine[Name]

export const EMPTY: Machine = {}
