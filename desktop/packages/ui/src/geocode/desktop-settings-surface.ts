/* --- GeoCode: settings surfaces the desktop shell does not offer (docs/DESKTOP.md §7.3).
 *
 * The kernel is embedded, so choosing a system OpenCode binary or upgrading one is not a
 * product action. The section itself is wrapped away in OpenChamberPage.tsx; this module is
 * the second half of that decision, the search entries that would otherwise point at a section
 * that is not on the page. Both sides read from here so they cannot disagree. --- */

export const HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS: ReadonlySet<string> = new Set([
  'sessions.opencode-binary',
  'sessions.opencode-update-notifications',
]);

export const isSettingsSearchItemHiddenOnDesktop = (id: string, desktopShell: boolean): boolean =>
  desktopShell && HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id);
