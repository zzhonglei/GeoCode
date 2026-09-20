/* --- GeoCode: a merge that takes upstream's side of the unmarked dictionaries must not name OpenChamber or OpenCode
 * in text the desktop shell shows; a new such string fails until it is exempted by decision
 * (docs/PATHS.md §3.4, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dict as en } from '../lib/i18n/messages/en';
import { dict as zhCN } from '../lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../lib/i18n/messages/zh-TW';

const UPSTREAM_BRAND = /openchamber|opencode/i;

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// A prefix excuses a whole surface at once, so unlike a named key it is never re-judged string by
// string. What keeps each one true is named here and checked below: `sessionAuth.` sat in this list
// on a premise that was only ever a prose comment, and it was never true.
const EXEMPT_SURFACES: ReadonlyArray<{ prefix: string; closedBy: string; closure: string }> = [
  {
    prefix: 'settings.remoteInstances.',
    closedBy: 'packages/ui/src/lib/settings/metadata.ts',
    closure: 'isAvailable: (ctx) => !ctx.isVSCode && !ctx.isDesktop, // GeoCode: the desktop shell has one host',
  },
  {
    prefix: 'desktopHostSwitcher.',
    closedBy: 'packages/ui/src/components/layout/Header.tsx',
    closure: '// --- GeoCode: this menu is the host switcher; the desktop shell has one host',
  },
  {
    prefix: 'onboarding.chooser.',
    closedBy: 'packages/ui/src/App.tsx',
    closure: '<GeoCodeKernelFailureScreen />',
  },
  {
    prefix: 'onboarding.localSetup.',
    closedBy: 'packages/ui/src/App.tsx',
    closure: '<GeoCodeKernelFailureScreen />',
  },
  {
    prefix: 'onboarding.remoteConnection.',
    closedBy: 'packages/ui/src/App.tsx',
    closure: '<GeoCodeKernelFailureScreen />',
  },
  {
    prefix: 'onboarding.desktopRecovery.',
    closedBy: 'packages/ui/src/App.tsx',
    closure: '<GeoCodeKernelFailureScreen />',
  },
  {
    prefix: 'opencodeUpdate.',
    closedBy: 'packages/web/server/lib/opencode/routes.js',
    closure: '// --- GeoCode: no system OpenCode to choose or upgrade; registered first',
  },
  {
    prefix: 'settings.openchamber.opencodeCli.',
    closedBy: 'packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx',
    closure: 'const OpenCodeCliSettings: React.FC = () => (isDesktopShell() ? null',
  },
  {
    prefix: 'settings.openchamber.tools.',
    closedBy: 'packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx',
    closure: 'const OpenChamberToolsSettings: React.FC = () => (isDesktopShell() ? null',
  },
  {
    prefix: 'settings.behavior.page.systemPromptOptimization.',
    closedBy: 'packages/ui/src/components/sections/behavior/BehaviorPage.tsx',
    closure: '{!isVSCode && !isDesktopShell() && (',
  },
  {
    prefix: 'settings.extensions.',
    closedBy: 'packages/ui/src/lib/guests/load-catalog.ts',
    closure: 'if (isDesktopShell() || isVSCodeRuntime() || isMobileSurfaceRuntime()) {',
  },
  {
    prefix: 'settings.integrations.guests.',
    closedBy: 'packages/ui/src/lib/guests/load-catalog.ts',
    closure: 'if (isDesktopShell() || isVSCodeRuntime() || isMobileSurfaceRuntime()) {',
  },
  {
    prefix: 'chat.chatInput.toast.guest',
    closedBy: 'packages/ui/src/lib/guests/load-catalog.ts',
    closure: 'if (isDesktopShell() || isVSCodeRuntime() || isMobileSurfaceRuntime()) {',
  },
  {
    prefix: 'settings.page.extensions.',
    closedBy: 'packages/ui/src/lib/settings/metadata.ts',
    closure: 'isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile && !ctx.isDesktop,',
  },
  {
    prefix: 'settings.skills.catalog.',
    closedBy: 'packages/ui/src/lib/settings/metadata.ts',
    closure: "// GeoCode: installing skills from upstream's catalogs is not a surface GeoCode offers",
  },
];

// Platforms the desktop shell is not, rather than surfaces it closes: there is no patch of ours to
// regress, so there is nothing here to check.
const FOREIGN_PLATFORM_PREFIXES = ['mobile.connect.', 'mobileUpdate.', 'pwa.installPrompt.'];

const EXEMPT_PREFIXES = [...EXEMPT_SURFACES.map((s) => s.prefix), ...FOREIGN_PLATFORM_PREFIXES];

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
  // No caller.
  'settings.themeImport.hint',
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

  test('every exempt surface still has the closure that makes it exempt', () => {
    const broken = EXEMPT_SURFACES
      .filter(({ closedBy, closure }) => !readFileSync(path.join(DESKTOP, closedBy), 'utf8').includes(closure))
      .map(({ prefix, closedBy }) => `${prefix} -> ${closedBy}`);
    expect(broken).toEqual([]);
  });

  test('the scan sees a leak when there is one', () => {
    expect(leaks({ 'x.y': 'Saved. OpenCode reloading…' })).toHaveLength(1);
    expect(leaks({ 'settings.remoteInstances.x': 'Install OpenChamber remotely' })).toHaveLength(0);
  });
});
