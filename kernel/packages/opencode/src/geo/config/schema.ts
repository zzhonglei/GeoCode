export * as MachineSchema from "./schema"

import { Schema } from "effect"
import { optional } from "@opencode-ai/schema/schema"

/* --- GeoCode: the schema for `machine.json`, one block per capability domain (docs/GEOKERNEL.md §3.1). --- */

export const BlockNames = ["qgis", "gee", "gdal"] as const
export type BlockName = (typeof BlockNames)[number]

/** A location hint anywhere inside a QGIS install, not only the interpreter path (docs/GEOKERNEL.md §4.2). */
export const Qgis = Schema.String

/** Optional though both are needed: a required field would fail the whole file's decode and every other block. */
export const Gee = Schema.Struct({
  python: optional(Schema.String),
  project: optional(Schema.String),
})
export interface Gee extends Schema.Schema.Type<typeof Gee> {}

/** The directory holding the GDAL command-line tools, not an executable path. */
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
