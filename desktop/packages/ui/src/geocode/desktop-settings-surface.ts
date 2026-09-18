/* --- GeoCode: settings search entries whose controls the desktop shell does not render, so a control brought back
 * needs its entry removed here (docs/DESKTOP.md §7.3). --- */

export const HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS: ReadonlySet<string> = new Set([
  'sessions.opencode-binary',
  'sessions.opencode-update-notifications',
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
  'sessions.agent-control-tool',
  'sessions.agent-web-tool',
  // Its row sits in the hidden agent tools section, so the entry would lead nowhere once upstream enables the feature.
  'sessions.agent-memory-tool',
  'behavior.system-prompt-optimization',
  'chat.draft-starters-visible',
  // Repository sharing is not offered (repository-sharing-surface.ts).
  'projects.shared',
  'projects.shared.plansDir',
  // Nor the worktree setup-command block (advanced-project-surface.ts).
  'projects.worktree.setup.wait',
  'projects.worktree.setup.replace',
  // The usage-report switch controls nothing in the desktop shell (docs/DESKTOP.md §7.2).
  'appearance.usage-reports',
]);

export const isSettingsSearchItemHiddenOnDesktop = (id: string, desktopShell: boolean): boolean =>
  desktopShell && HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id);
