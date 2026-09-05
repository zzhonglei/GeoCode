/* --- GeoCode: single source of truth for the desktop shell's user-visible identity
 * (docs/PATHS.md §3.4).
 *
 * Every field derives from the two base strings, and a new one must derive too rather than
 * be written flat — the same reason `core/src/brand.ts` gives on the kernel side: a flat
 * literal is a second place to keep in sync by hand, and nothing fails when it drifts.
 *
 * Wire fingerprints stay upstream and must NOT move here: the `OPENCHAMBER_*` variables the
 * shell runtime reads, the `@openchamber/electron` package name other workspace packages
 * import, the `openchamber:` IPC channel names the renderer listens on, and the upstream
 * repository URLs behind the changelog and issue links. Those identify the code, not the
 * product, and changing them breaks things without making the app any more ours.
 *
 * `package.json` cannot import this: it is JSON, one of the two file kinds that carry no
 * patch marker (CONVENTIONS.md §5). Its build fields are therefore written out, and
 * `desktop-identity.test.mjs` pins them to these values so the two cannot drift. --- */

const dirName = 'GeoCode';
const name = 'geocode';

export const DesktopIdentity = {
  /** Cased. Product name, userData directory, and what electron-log derives its log path from. */
  dirName,
  /** Lowercase, for protocols and executable names. */
  name,
  productName: dirName,
  /** Dev builds only; packaged builds get `dirName` from `setName` without an explicit path. */
  devUserDataDirectory: `${dirName} Dev`,
  appId: `ai.${name}.desktop`,
  devAppId: `ai.${name}.desktop.dev`,
  deepLinkProtocol: name,
  uiProtocol: `${name}-ui`,
  /** Linux only. Derived anyway so the platform branch cannot drift from the rest. */
  executableName: name,
  desktopEntryName: `${name}.desktop`,
  /** Chromium storage partition for the browser panel. Lives inside userData. */
  browserPanelPartition: `persist:${name}-browser`,
  /**
   * Windows installs to a directory taken from package.json `name`, NOT `productName`.
   * PATHS.md §2 records what that cost: GeoCode once installed into the same directory as
   * upstream and the two overwrote each other, and the wrong path then sticks in the
   * registry's `InstallLocation` where reinstalling does not clear it. electron-builder's
   * `extraMetadata` rewrites `name` at package time; this is the value it writes.
   */
  windowsPackageName: dirName,
  /**
   * Releases live in a repository of their own, as they did for the previous GeoCode. The
   * app only announces them (docs/DESKTOP.md §7.2); the renderer keeps a hand-copy of
   * `releasesUrl` in UpdateDialog.tsx, pinned by desktop-identity.test.mjs.
   */
  releaseRepository: `zzhonglei/${dirName}-Release`,
  releasesUrl: `https://github.com/zzhonglei/${dirName}-Release/releases`,
  releasesApiUrl: `https://api.github.com/repos/zzhonglei/${dirName}-Release/releases/latest`,
};
