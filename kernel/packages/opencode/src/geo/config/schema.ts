export * as MachineSchema from "./schema"

import { Schema } from "effect"
import { optional } from "@opencode-ai/schema/schema"

/* --- GeoCode: the schema for `machine.json` — this machine's geographic environment (docs/PATHS.md §3.2,
 * docs/GEOKERNEL.md §3.1). Every field is a place the user can get something wrong, so it stays as small as
 * derivation allows. --- */

/** One block per capability domain: the unit of change dispatch, fingerprinting, and parse-failure blast radius. */
export const BlockNames = ["qgis", "gee", "gdal"] as const
export type BlockName = (typeof BlockNames)[number]

/** A location hint anywhere inside a QGIS install — five accepted shapes, all deriving to one environment (§4.2). */
export const Qgis = Schema.String

/**
 * Optional though both are needed to run: a required field here would fail the whole file's decode and take the
 * other blocks down with it. They are also checked at opposite ends of the chain — `unconfigured` before any
 * subprocess runs, `project-missing` only after credentials check out (§5.2).
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

export type BlockValue<Name extends BlockName = BlockName> = Machine[Name]

export const EMPTY: Machine = {}
