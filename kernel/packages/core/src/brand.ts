/* --- GeoCode: single source of truth for on-disk and system identity strings (docs/PATHS.md §5).
 *
 * Every field derives from the two base strings below, and a new one is derived too, never a flat literal — the
 * brand test enumerates the fields it knows, so a literal added later is left behind silently the next time the
 * base changes. Wire fingerprints (OPENCODE_* env vars, npm package names, User-Agent, the config $schema URL)
 * stay upstream and must not move here. --- */
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
  /** Spread by both the plan writer and the plan agent's edit glob; `readonly`, not `as const` — nothing reads them as literals. */
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
