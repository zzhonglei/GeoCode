/* --- GeoCode: settings surfaces the desktop shell does not offer (docs/DESKTOP.md §7.3).
 *
 * The kernel is embedded, so choosing a system OpenCode binary or upgrading one is not a
 * product action; and the shell listens on loopback only (§6.1), so LAN access and the UI
 * password that guards it are not either. The sections themselves are wrapped away in
 * OpenChamberPage.tsx; this module is the second half of those decisions, the search entries
 * that would otherwise point at controls that are not on the page. Both sides read from here
 * so they cannot disagree. --- */

export const HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS: ReadonlySet<string> = new Set([
  'sessions.opencode-binary',
  'sessions.opencode-update-notifications',
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
]);

export const isSettingsSearchItemHiddenOnDesktop = (id: string, desktopShell: boolean): boolean =>
  desktopShell && HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id);
