export * as Bundled from "./bundled.ts"

/**
 * How an interpreter of GeoCode's Python environment is run, as options for `Runtime.run`: isolated, since the
 * environment sets its own variables as it starts.
 */
export const python = (command: string, args: readonly string[]) =>
  // As flags: isolated, Python ignores PYTHONUTF8 and PYTHONUNBUFFERED.
  ({ command, args: ["-I", "-X", "utf8", "-u", ...args] })
