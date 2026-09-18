/* --- GeoCode: settings the desktop shell does not offer must stay off both the page and the settings search, so a
 * merge can bring back neither a control nor an entry that leads to it (docs/DESKTOP.md §6.1, §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS, isSettingsSearchItemHiddenOnDesktop } from './desktop-settings-surface';
import { getSettingsPageMeta } from '../lib/settings/metadata';

const read = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

const componentFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [full] : [];
  });

const KEPT_DESKTOP_OPTION_IDS = [
  'sessions.desktop-launch-at-login',
  'sessions.desktop-mac-menu-bar',
  'sessions.desktop-minimize-to-tray',
  'sessions.desktop-keep-awake',
];

describe('desktop settings surface', () => {
  test('the hidden search entries are hidden in the desktop shell only', () => {
    for (const id of [
      'sessions.opencode-binary',
      'sessions.desktop-ui-password',
      'sessions.desktop-lan-access',
      'sessions.agent-control-tool',
      'sessions.agent-web-tool',
      'sessions.agent-memory-tool',
      'behavior.system-prompt-optimization',
      'chat.draft-starters-visible',
      'projects.shared',
      'projects.shared.plansDir',
      'projects.worktree.setup.wait',
      'projects.worktree.setup.replace',
      'appearance.usage-reports',
    ]) {
      expect(HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS.has(id)).toBe(true);
    }
    for (const id of HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS) {
      expect(isSettingsSearchItemHiddenOnDesktop(id, true)).toBe(true);
      expect(isSettingsSearchItemHiddenOnDesktop(id, false)).toBe(false);
    }
    for (const id of KEPT_DESKTOP_OPTION_IDS) {
      expect(isSettingsSearchItemHiddenOnDesktop(id, true)).toBe(false);
    }
  });

  test('the ids this surface names are the ids the search table declares', () => {
    // Both halves go stale in silence: a hidden id that no longer exists hides nothing, and a kept id that no
    // longer matches leaves a search hit that scrolls nowhere.
    const search = read('lib/settings/search.ts');
    for (const id of [...HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS, ...KEPT_DESKTOP_OPTION_IDS]) {
      expect(search).toContain(`id: '${id}'`);
    }
    expect(search).toContain('isSettingsSearchItemHiddenOnDesktop(item.id, isDesktopShell())');
  });

  test('the usage-report switch is listed outside the desktop shell only', () => {
    // OpenChamberVisualSettings.tsx declares the name and renders the section; every other file only lists it.
    const lists = componentFiles(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
      .filter((file) => !file.endsWith(`${path.sep}OpenChamberVisualSettings.tsx`))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((line) => line.includes("'reportUsage'")));
    expect(lists.length).toBeGreaterThan(0);
    for (const line of lists) {
      expect(line).toContain("...(isDesktopShell() ? [] : ['reportUsage' as const])");
    }
  });

  test('the settings page renders the OpenCode CLI section through the desktop guard only', () => {
    const page = read('components/sections/openchamber/OpenChamberPage.tsx');
    expect(page).toContain("import { OpenCodeCliSettings as UpstreamOpenCodeCliSettings } from './OpenCodeCliSettings'");
    expect(page).toContain('isDesktopShell() ? null : <UpstreamOpenCodeCliSettings />');
    expect(page.match(/<OpenCodeCliSettings \/>/g)?.length).toBe(2);
    expect(page.match(/<UpstreamOpenCodeCliSettings \/>/g)?.length).toBe(1);
  });

  test('the settings page renders the desktop section through the GeoCode component only', () => {
    const page = read('components/sections/openchamber/OpenChamberPage.tsx');
    expect(page).toContain("import { DesktopNetworkSettings as UpstreamDesktopNetworkSettings } from './DesktopNetworkSettings'");
    expect(page).toContain('isDesktopShell() ? <GeoCodeDesktopSettings /> : <UpstreamDesktopNetworkSettings />');
    expect(page.match(/<DesktopNetworkSettings \/>/g)?.length).toBe(2);
    expect(page.match(/<UpstreamDesktopNetworkSettings \/>/g)?.length).toBe(1);
  });

  test('the GeoCode desktop section keeps the machine options and has no network half', () => {
    const section = read('geocode/GeoCodeDesktopSettings.tsx');
    for (const id of KEPT_DESKTOP_OPTION_IDS) {
      expect(section).toContain(`settingsItem="${id}"`);
    }
    for (const id of ['sessions.desktop-ui-password', 'sessions.desktop-lan-access']) {
      expect(section).not.toContain(id);
    }
    for (const token of ['desktopLanAccess', 'desktopUiPassword', 'getDesktopLanAddress']) {
      expect(section).not.toContain(token);
    }
    expect(section.match(/desktopMacMenuBarEnabled: draftMacMenuBarEnabled/g)?.length).toBe(1);
  });

  test('the External Tunnel page is unavailable in the desktop shell only', () => {
    // Navigation, direct routes and search all read this predicate (SettingsView.tsx, search.ts), so it closes
    // every way to reach a page.
    const tunnel = getSettingsPageMeta('tunnel');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(tunnel?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(tunnel?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the Plugins page is unavailable in the desktop shell only', () => {
    const plugins = getSettingsPageMeta('plugins');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(plugins?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(plugins?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the Magic Prompts page is unavailable in the desktop shell only', () => {
    const prompts = getSettingsPageMeta('magic-prompts');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(prompts?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(prompts?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the Snippets page is unavailable in the desktop shell only', () => {
    const snippets = getSettingsPageMeta('snippets');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(snippets?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(snippets?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the Skills Catalog page is unavailable in the desktop shell only', () => {
    const catalog = getSettingsPageMeta('skills.catalog');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(catalog?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(catalog?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the composer offers no snippet popup in the desktop shell', () => {
    // Three composers mount it, so a merge that reinstates upstream's direct export reopens all of them.
    const source = read('components/chat/SnippetAutocomplete.tsx');
    expect(source).toContain('const SnippetAutocompleteUpstream = React.forwardRef');
    expect(source).toContain('isDesktopShell() ? null :');
  });

  test('no starter row under a new session in the desktop shell, and no switch for it', () => {
    const chips = read('components/chat/DraftPresetChips.tsx');
    const component = chips.indexOf('export const DraftPresetChips:');
    const guard = chips.indexOf('if (isDesktopShell()) return null;', component);
    expect(component).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(component);
    expect(chips.indexOf('<DraftPresetChipsContent', component)).toBeGreaterThan(guard);
    const visual = read('components/sections/openchamber/OpenChamberVisualSettings.tsx');
    const row = visual.indexOf('settingsItem="chat.draft-starters-visible"');
    const rowGuard = visual.lastIndexOf('{!isDesktopShell() && (', row);
    expect(rowGuard).toBeGreaterThan(-1);
    expect(visual.slice(rowGuard, row).match(/<SettingsCheckboxRow/g)?.length).toBe(1);
    expect(visual.slice(visual.indexOf('/>', row) + 2).trimStart().startsWith(')}')).toBe(true);
  });

  test('the Remote Instances page is unavailable in the desktop shell only', () => {
    const remote = getSettingsPageMeta('remote-instances');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(remote?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(remote?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
  });

  test('the header services menu, which is the host switcher, renders nothing in the desktop shell', () => {
    const header = read('components/layout/Header.tsx');
    const menu = header.indexOf('function DesktopServicesMenu(');
    const guard = header.indexOf('if (isDesktopShell()) return null;', menu);
    const firstReturn = header.indexOf('return (', menu);
    expect(menu).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(menu);
    expect(guard).toBeLessThan(firstReturn);
  });

  test('the settings page renders the agent tools section through the desktop guard only', () => {
    const page = read('components/sections/openchamber/OpenChamberPage.tsx');
    expect(page).toContain("import { OpenChamberToolsSettings as UpstreamOpenChamberToolsSettings } from './OpenChamberToolsSettings'");
    expect(page).toContain('isDesktopShell() ? null : <UpstreamOpenChamberToolsSettings />');
    expect(page.match(/<OpenChamberToolsSettings \/>/g)?.length).toBe(2);
    expect(page.match(/<UpstreamOpenChamberToolsSettings \/>/g)?.length).toBe(1);
  });

  test('the behaviour page renders the system-prompt optimizer outside the desktop shell only', () => {
    const page = read('components/sections/behavior/BehaviorPage.tsx');
    const guard = page.indexOf('{!isVSCode && !isDesktopShell() && (');
    const section = page.indexOf("t('settings.behavior.page.section.systemPromptOptimization')", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(guard);
    expect(page).toContain("t('settings.behavior.page.section.systemPrompt')");
  });
});
