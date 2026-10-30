export * as Library from "./library.ts"

/**
 * Task and asset names: Earth Engine's own rule, with room for both in an export's description (see
 * geocodekit/gee/_run.py). The kernel checks a task's before asking the user (TASK_NAME in
 * kernel/packages/core/src/geocode/geerun.ts).
 */
export const NAME = /^[A-Za-z0-9_-]{1,30}$/

/** What GeoAgent is told of a name that breaks NAME. */
export const NAME_RULE = 'use 1 to 30 letters, digits, "_" or "-"'

/** The folder in the user's Earth Engine assets that GeoCode keeps its tasks in. */
export const FOLDER = "GeoCode"
