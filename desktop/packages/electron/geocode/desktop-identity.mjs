/* --- GeoCode: the desktop shell's user-visible identity (docs/PATHS.md §3.4). New fields derive from the two base
 * strings rather than repeat them. Wire names stay upstream's: the `OPENCHAMBER_*` variables, the
 * `@openchamber/electron` package name and the `openchamber:` IPC channels identify the code, not the product. --- */

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
  /** Linux only. */
  executableName: name,
  desktopEntryName: `${name}.desktop`,
  browserPanelPartition: `persist:${name}-browser`,
  /**
   * A one-click Windows install is named after package.json `name`, not `productName`; `build.extraMetadata.name`
   * rewrites it to this value (docs/PATHS.md §2).
   */
  windowsPackageName: dirName,
  /** The renderer hand-copies `releasesUrl` in UpdateDialog.tsx. */
  releaseRepository: `zzhonglei/${dirName}-Release`,
  releasesUrl: `https://github.com/zzhonglei/${dirName}-Release/releases`,
  releasesApiUrl: `https://api.github.com/repos/zzhonglei/${dirName}-Release/releases/latest`,
  /** Where Help → Report a Bug and Request a Feature send the user. */
  newIssueUrl: `https://github.com/zzhonglei/${dirName}-Release/issues/new`,
};
