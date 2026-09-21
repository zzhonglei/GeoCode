/* --- GeoCode: a merge that takes upstream's side of the unmarked dictionaries must not name OpenChamber or OpenCode
 * in text the desktop shell shows; a new such string fails until it is exempted by decision
 * (docs/PATHS.md §3.4, docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTINGS_PAGE_METADATA } from '../lib/settings/metadata';
import { HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS } from './desktop-settings-surface';
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
    prefix: 'settings.routing.',
    closedBy: 'packages/web/server/lib/routing/feature-flag.js',
    closure: 'if (process.versions.electron) return false;',
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

const sourceFiles = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue;
      if (full.includes(`${path.sep}i18n${path.sep}messages${path.sep}`)) continue;
      files.push(full);
    }
  };
  walk(path.join(DESKTOP, 'packages/ui/src'));
  return files;
};

// Exempt because the renderer never asks for them. Unlike the reasons below, this premise is mechanical,
// so the test checks it rather than trusting the comment: it scans the source for the key and for any
// dynamically built key that could reach it.
const UNCALLED_KEYS = [
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
] as const;

// Each key names every file that asks for it. That list is checked against the source, so a key that
// gains a caller anywhere turns this red — which is the failure the older flat set could not see. Where
// the caller is a settings page or a settings-search entry, the reason is machine-checked below against
// the real predicate; the rest carry a reason a reader has to weigh, and that is the remaining gap.
const EXEMPT_KEYS_WITH_CALLERS: ReadonlyArray<{
  key: string;
  usedBy: readonly string[];
  closedPage?: string;
  hiddenSearchId?: string;
  why?: string;
}> = [
  { key: 'aboutDialog.openChamberVersionLabel', usedBy: ['components/ui/AboutDialog.tsx', 'components/sections/openchamber/AboutSettings.tsx'], closedPage: 'about', why: 'App.tsx shows GeoCodeAboutDialog in the desktop shell' },
  { key: 'aboutDialog.openCodeVersionLabel', usedBy: ['components/ui/AboutDialog.tsx', 'components/sections/openchamber/AboutSettings.tsx'], closedPage: 'about', why: 'App.tsx shows GeoCodeAboutDialog in the desktop shell' },
  { key: 'aboutDialog.diagnosticsDescription', usedBy: ['components/ui/AboutDialog.tsx'], why: 'App.tsx shows GeoCodeAboutDialog in the desktop shell' },
  { key: 'settings.openchamber.about.field.openCodeVersion', usedBy: ['components/sections/openchamber/AboutSettings.tsx'], closedPage: 'about' },
  // The update dialog is mounted by AboutSettings alone, and its two helpers only feed that dialog.
  { key: 'updateDialog.error.takingLonger', usedBy: ['components/ui/UpdateDialog.tsx'], closedPage: 'about' },
  { key: 'updateDialog.header.updating', usedBy: ['components/ui/UpdateDialog.tsx'], closedPage: 'about' },
  { key: 'updateDialog.error.signatureRejected', usedBy: ['lib/updateInstallError.ts'], closedPage: 'about' },
  { key: 'updateDialog.error.updaterDisabled', usedBy: ['lib/updateInstallError.ts'], closedPage: 'about' },
  { key: 'updateDialog.error.restartUnavailable', usedBy: ['stores/useUpdateStore.ts'], closedPage: 'about' },
  // Restart branches the shell does not take: it restarts its own kernel rather than asking the user to.
  { key: 'settings.view.pendingRestart.manualRestartRequired', usedBy: ['components/views/OpenCodeReloadFooterAction.tsx'], why: 'only on result.requiresManualRestart, which the shell-managed kernel does not report' },
  { key: 'settings.agents.page.toast.savedManualRestart', usedBy: ['components/sections/agents/AgentsPage.tsx', 'components/sections/agents/AgentsSidebar.tsx'], why: 'same restart branch' },
  { key: 'settings.agents.page.permissionsEditor.toast.savedRestartRequired', usedBy: ['components/sections/agents/AgentPermissionsEditor.tsx'], why: 'same restart branch' },
  // Repository sharing is closed (geocode/repository-sharing-surface.ts).
  { key: 'projects.sharedTrust.description', usedBy: ['components/projects/SharedTrustConfirmDialog.tsx'], why: 'the shared repository file is refused, so the dialog never opens' },
  { key: 'settings.projects.shared.plansDirPlaceholder', usedBy: ['components/sections/projects/SharedProjectConfigSection.tsx'], why: 'the section is not rendered in the desktop shell' },
  { key: 'settings.projects.shared.plansDirInfo', usedBy: ['components/sections/projects/SharedProjectConfigSection.tsx', 'lib/settings/search.ts'], hiddenSearchId: 'projects.shared.plansDir' },
  { key: 'settings.snippets.page.hint', usedBy: ['components/sections/snippets/SnippetsPage.tsx'], closedPage: 'snippets' },
  { key: 'settings.plugins.toast.reloadFailed', usedBy: ['components/sections/plugins/PluginsPage.tsx', 'components/sections/plugins/AddPluginDialog.tsx'], closedPage: 'plugins' },
  { key: 'settings.openchamber.tunnel.tooltip.tokensSavedPath', usedBy: ['components/sections/openchamber/TunnelSettings.tsx'], closedPage: 'tunnel' },
  { key: 'settings.openchamber.desktopPassword.field.passwordDescription', usedBy: ['components/sections/openchamber/DesktopNetworkSettings.tsx', 'lib/settings/search.ts'], hiddenSearchId: 'sessions.desktop-ui-password' },
  { key: 'walkthrough.blocked.serverUnsupported.description', usedBy: ['components/views/walkthrough/WalkthroughBlocker.tsx'], why: 'the blocker names an OpenCode server too old for walkthroughs; the shell ships its own kernel' },
  { key: 'contextPanel.browser.devServers.remoteOnly', usedBy: ['components/browser/BrowserEmptyState.tsx'], why: 'only when the runtime is remote, and the desktop shell has one host, this machine' },
  { key: 'contextPanel.browser.tunnelFailedHint', usedBy: ['components/browser/BrowserPane.tsx'], why: 'only when a tunnel URL failed, and no tunnel is offered' },
];

const EXEMPT_KEYS = new Set<string>([
  ...UNCALLED_KEYS,
  ...EXEMPT_KEYS_WITH_CALLERS.map((entry) => entry.key),
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

  test('every key exempted for having no caller still has none', () => {
    const sources = sourceFiles();

    const quoted = new Set<string>();
    const builtPrefixes = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      // Any quoted occurrence, not only `t('...')`: a key handed around as a constant is still a caller.
      for (const match of text.matchAll(/['"`]([\w.]+\.[\w.]+)['"`]/g)) quoted.add(match[1]);
      // `\bt\(` rather than `t\(`, or `test(` and `expect(` would supply prefixes of their own.
      for (const match of text.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) if (match[1]) builtPrefixes.add(match[1]);
    }
    const called = UNCALLED_KEYS.filter((key) =>
      quoted.has(key) || [...builtPrefixes].some((prefix) => key.startsWith(prefix)));
    // Guards the reader: with nothing collected the filter above would hold for any list at all.
    expect([quoted.size > 100, builtPrefixes.size > 0, called]).toEqual([true, true, []]);
  });

  test('every exempt key is asked for only where it is recorded', () => {
    // Read once and reused across the keys; the earlier shape re-walked the tree for every one of them.
    const sources = sourceFiles().map((file) => ({
      relative: path.relative(path.join(DESKTOP, 'packages/ui/src'), file).split(path.sep).join('/'),
      text: readFileSync(file, 'utf8'),
    }));
    const referenced = (key: string) => sources
      .filter(({ text }) => text.includes(`'${key}'`) || text.includes(`"${key}"`))
      .map(({ relative }) => relative)
      .sort();
    const drifted = EXEMPT_KEYS_WITH_CALLERS
      .map((entry) => ({ key: entry.key, found: referenced(entry.key), declared: [...entry.usedBy].sort() }))
      .filter(({ found, declared }) => found.join('|') !== declared.join('|'))
      .map(({ key, found, declared }) => `${key}: ${found.join(', ')} (recorded: ${declared.join(', ')})`);
    expect(drifted).toEqual([]);
  });

  test('every page named as closed really refuses the desktop shell', () => {
    // The real predicate, evaluated, rather than its source text: a rewritten condition that still closes
    // the page should not turn this red, and one that stops closing it must.
    const desktop = { isVSCode: false, isWeb: false, isDesktop: true, isMobile: false, routingAvailable: false };
    const open = [...new Set(EXEMPT_KEYS_WITH_CALLERS.map((entry) => entry.closedPage).filter(Boolean))]
      .map((slug) => ({ slug, meta: SETTINGS_PAGE_METADATA.find((page) => page.slug === slug) }))
      .filter(({ meta }) => !meta || meta.isAvailable?.(desktop) !== false)
      .map(({ slug }) => slug);
    expect(open).toEqual([]);
  });

  test('every search entry named as hidden is still hidden', () => {
    const shown = EXEMPT_KEYS_WITH_CALLERS
      .map((entry) => entry.hiddenSearchId)
      .filter((id): id is string => Boolean(id))
      .filter((id) => !HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id));
    expect(shown).toEqual([]);
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
