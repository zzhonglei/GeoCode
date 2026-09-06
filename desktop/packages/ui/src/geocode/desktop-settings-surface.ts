/* --- GeoCode: settings surfaces the desktop shell does not offer (docs/DESKTOP.md §7.3).
 *
 * The kernel is embedded, so choosing a system OpenCode binary or upgrading one is not a
 * product action; and the shell listens on loopback only (§6.1), so LAN access and the UI
 * password that guards it are not either. The agent tools are not switches in GeoCode: the
 * control tool is not offered, the browser tool is always on, and the system-prompt optimizer
 * is not a GeoCode capability. The sections themselves are wrapped away in OpenChamberPage.tsx
 * and BehaviorPage.tsx; this module is the second half of those decisions, the search entries
 * that would otherwise point at controls that are not on the page. Both sides read from here
 * so they cannot disagree. --- */

export const HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS: ReadonlySet<string> = new Set([
  'sessions.opencode-binary',
  'sessions.opencode-update-notifications',
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
  'sessions.agent-control-tool',
  'sessions.agent-web-tool',
  // Unreleased upstream and untouched here, but its row lives in the section above, so its
  // search entry would lead nowhere the day upstream turns the feature on.
  'sessions.agent-memory-tool',
  'behavior.system-prompt-optimization',
]);

export const isSettingsSearchItemHiddenOnDesktop = (id: string, desktopShell: boolean): boolean =>
  desktopShell && HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id);
