/* --- GeoCode: the product languages name GeoCode wherever the desktop shell shows the text
 * (docs/PATHS.md §3.4, docs/DESKTOP.md §7.3).
 *
 * Dictionaries carry no patch marker and an upstream merge rewrites them silently, so this binds
 * the consequence: any value naming OpenChamber or OpenCode must belong to a key the shell never
 * shows, or to one kept by decision. Whole surfaces are exempt by prefix; the rest are named one by
 * one, so a new upstream string anywhere else fails here until someone decides what it is. --- */
import { describe, expect, test } from 'bun:test';

import { dict as en } from '../lib/i18n/messages/en';
import { dict as zhCN } from '../lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../lib/i18n/messages/zh-TW';

const UPSTREAM_BRAND = /openchamber|opencode/i;

// Surfaces the desktop shell does not offer.
const EXEMPT_PREFIXES = [
  'settings.remoteInstances.',
  'desktopHostSwitcher.',
  'sessionAuth.error.',
  'sessionAuth.locked.',
  'onboarding.chooser.',
  'onboarding.localSetup.',
  'onboarding.remoteConnection.',
  'onboarding.desktopRecovery.',
  'opencodeUpdate.',
  'mobile.connect.',
  'mobileUpdate.',
  'pwa.installPrompt.',
  'settings.openchamber.opencodeCli.',
  'settings.openchamber.tools.',
  'settings.behavior.page.systemPromptOptimization.',
  'settings.skills.catalog.',
];

const EXEMPT_KEYS = new Set([
  // Unreachable in the desktop shell.
  'aboutDialog.openChamberVersionLabel',
  'aboutDialog.openCodeVersionLabel',
  'aboutDialog.diagnosticsDescription',
  'settings.openchamber.about.field.openCodeVersion',
  'updateDialog.error.takingLonger',
  'updateDialog.header.updating',
  'updateDialog.error.signatureRejected',
  'updateDialog.error.updaterDisabled',
  'updateDialog.error.restartUnavailable',
  'settings.view.pendingRestart.manualRestartRequired',
  'settings.agents.page.toast.savedManualRestart',
  'settings.agents.page.permissionsEditor.toast.savedRestartRequired',
  'projects.sharedTrust.description',
  'settings.projects.shared.plansDirPlaceholder',
  'settings.projects.shared.plansDirInfo',
  'settings.snippets.page.hint',
  'settings.plugins.toast.reloadFailed',
  'settings.openchamber.tunnel.tooltip.tokensSavedPath',
  'settings.openchamber.desktopPassword.field.passwordDescription',
  'walkthrough.blocked.serverUnsupported.description',
  'contextPanel.browser.devServers.remoteOnly',
  'contextPanel.browser.tunnelFailedHint',
  // Shown, and kept: GitHub authorizes upstream's OAuth app, whose own page names it.
  'settings.github.page.flow.title',
  'settings.github.page.ghCli.fallbackDescription',
  // No caller.
  'settings.providers.page.openCodeGo.title',
  'settings.providers.page.openCodeGo.description',
  'settings.providers.page.openCodeGo.help',
  'settings.providers.page.openCodeGo.valid',
  'settings.providers.page.openCodeGo.invalid',
  'settings.providers.page.openCodeGo.deleted',
  'settings.providers.page.openCodeGo.deleteFailed',
  'settings.openchamber.about.title',
  'settings.view.home.cards.plugins.description',
  'settings.skills.sidebar.badge.opencode',
  'settings.mcp.page.advanced.oauthHint',
  'settings.mcp.page.toast.openCodeReloadFailedAfterCallbackSave',
  'settings.integrations.linear.info',
  'contextPanel.browser.trustNotice',
  'multiRun.window.description',
]);

const isExempt = (key: string) => EXEMPT_KEYS.has(key) || EXEMPT_PREFIXES.some((prefix) => key.startsWith(prefix));

const leaks = (dictionary: Record<string, string>) => Object.entries(dictionary)
  .filter(([key, value]) => !isExempt(key) && UPSTREAM_BRAND.test(value))
  .map(([key, value]) => `${key}: ${value}`);

describe('locale strings and the product name', () => {
  test('the product languages name no upstream product where the shell shows the text', () => {
    expect(leaks(en)).toEqual([]);
    expect(leaks(zhCN)).toEqual([]);
    expect(leaks(zhTW)).toEqual([]);
  });

  test('the settings sidebar groups stay two distinct names', () => {
    for (const dictionary of [en, zhCN, zhTW]) {
      expect(dictionary['settings.view.nav.group.general']).not.toBe(dictionary['settings.view.nav.group.opencode']);
    }
  });

  test('every key named as exempt still exists', () => {
    expect([...EXEMPT_KEYS].filter((key) => !(key in en))).toEqual([]);
  });

  test('the scan sees a leak when there is one', () => {
    expect(leaks({ 'x.y': 'Saved. OpenCode reloading…' })).toHaveLength(1);
    expect(leaks({ 'settings.remoteInstances.x': 'Install OpenChamber remotely' })).toHaveLength(0);
  });
});
