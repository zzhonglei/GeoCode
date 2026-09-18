/* --- GeoCode: on-disk and system identity strings (docs/PATHS.md §5). Every field, including any added later,
 * derives from the two bases so a base change reaches it; wire fingerprints such as OPENCODE_* env vars, package
 * names, User-Agent and the config $schema URL stay upstream's and do not belong here. --- */
const dirName = "GeoCode"
const name = "geocode"
const projectDir = `.${name}`

export const Brand = {
  /** Cased, for XDG roots and system dirs (`~/.local/share/<dirName>`). */
  dirName,
  /** Lowercase, for file and network identifiers. */
  name,
  dbFile: `${name}.db`,
  channelDbFile: (channel: string) => `${name}-${channel}.db`,
  logFile: `${name}.log`,
  configJson: `${name}.json`,
  configJsonc: `${name}.jsonc`,
  /** The loader matches this directory before looking for `configJson` inside it, so the two cannot drift. */
  projectDir,
  /** Spread by the plan writer and by both plan-agent edit globs, so they cannot diverge. */
  plansSegments: [projectDir, "plans"] as readonly string[],
  mdnsHost: `${name}.local`,
  mdnsService: (port: number) => `${name}-${port}`,
  /** macOS managed-preferences plist domain. */
  managedDomain: `ai.${name}.managed`,
  /** Written into a repo's `.git` dir to identify the project. */
  projectMarker: name,
  /** Version marker inside skill staging dirs. */
  stagingMarker: `.${name}-version`,
  tempPrefix: (suffix: string) => `${name}-${suffix}`,
}
