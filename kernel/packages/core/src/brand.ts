/* --- GeoCode: single source of truth for on-disk and system identity strings.
 * Every branded path, file or service name in the kernel reads from here, so
 * one grep for "Brand." audits the full rename surface after an upstream
 * merge (see docs/PATHS.md §5). Wire fingerprints — OPENCODE_* env vars, npm
 * package names, User-Agent, config $schema URL — intentionally stay upstream
 * and MUST NOT move into this module.
 *
 * Everything derives from the two base strings below, so the identity cannot
 * drift apart: a file name and the directory-scan base name that has to match
 * it are the same expression, not two literals kept in sync by hand. --- */
const dirName = "GeoCode"
const name = "geocode"
const projectDir = `.${name}`

export const Brand = {
  /** Cased namespace for XDG roots and system dirs (~/.local/share/<dirName>) */
  dirName,
  /** Lowercase base for file and network identifiers; also the config base name */
  name,
  /** Primary database file (packaged beta/prod channels) */
  dbFile: `${name}.db`,
  /** Per-channel database file (dev/local builds) */
  channelDbFile: (channel: string) => `${name}-${channel}.db`,
  /** Rolling log file under <data>/log/ */
  logFile: `${name}.log`,
  /** Global-config-dir file names — must stay `${name}.json(c)`, see below */
  configJson: `${name}.json`,
  configJsonc: `${name}.jsonc`,
  /**
   * Per-project config directory. Derived from `name` so it can never drift
   * from the config file names above: the loader checks that a directory is
   * this one BEFORE looking for `configJson` inside it, and if the two ever
   * disagreed the check would pass while the file was never found — silently.
   */
  projectDir,
  /**
   * Plan files, as path segments. An array rather than a string because two
   * call sites must agree: the writer joins it under the worktree, and the
   * plan agent's edit permission joins it into a glob. Spreading one array in
   * both places makes a drift between "where we write" and "what we allow"
   * impossible to express.
   */
  plansSegments: [projectDir, "plans"] as const,
  /** mDNS default host and service name */
  mdnsHost: `${name}.local`,
  mdnsService: (port: number) => `${name}-${port}`,
  /** macOS managed-preferences plist domain */
  managedDomain: `ai.${name}.managed`,
  /** Project id marker file the kernel writes into a repo's .git dir */
  projectMarker: name,
  /** Version marker file inside skill staging dirs */
  stagingMarker: `.${name}-version`,
  /** Prefix for branded scratch dirs under the system temp dir */
  tempPrefix: (suffix: string) => `${name}-${suffix}`,
}
