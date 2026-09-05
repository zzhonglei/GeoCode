/* --- GeoCode: the "OpenCode CLI" section and the network half of the desktop section stay
 * off the desktop shell (docs/DESKTOP.md §7.3, §6.1).
 *
 * Two halves have to agree: the page must not render the controls, and the settings search
 * must not offer entries that lead to them. The filter is a pure function pinned here; the
 * call sites are pinned by reading their source, because a renderer test that mounts the
 * settings page would drag every store along and prove less than it costs. --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS, isSettingsSearchItemHiddenOnDesktop } from './desktop-settings-surface';
import { getSettingsPageMeta } from '../lib/settings/metadata';

const read = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

const KEPT_DESKTOP_OPTION_IDS = [
  'sessions.desktop-launch-at-login',
  'sessions.desktop-mac-menu-bar',
  'sessions.desktop-minimize-to-tray',
  'sessions.desktop-keep-awake',
];

describe('desktop settings surface', () => {
  test('the hidden search entries are hidden in the desktop shell only', () => {
    for (const id of ['sessions.opencode-binary', 'sessions.desktop-ui-password', 'sessions.desktop-lan-access']) {
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

  test('the hidden ids are the ids the search table declares', () => {
    const search = read('lib/settings/search.ts');
    for (const id of HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS) {
      expect(search).toContain(`id: '${id}'`);
    }
    expect(search).toContain('isSettingsSearchItemHiddenOnDesktop(item.id, isDesktopShell())');
  });

  test('the settings page renders the OpenCode CLI section through the desktop guard only', () => {
    const page = read('components/sections/openchamber/OpenChamberPage.tsx');
    expect(page).toContain("import { OpenCodeCliSettings as UpstreamOpenCodeCliSettings } from './OpenCodeCliSettings'");
    expect(page).toContain('isDesktopShell() ? null : <UpstreamOpenCodeCliSettings />');
    // The upstream JSX sites keep their name, so they resolve to the guarded component above.
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
    // The menu bar option is the only value that goes through the settings file.
    expect(section.match(/desktopMacMenuBarEnabled: draftMacMenuBarEnabled/g)?.length).toBe(1);
  });

  test('the External Tunnel page is unavailable in the desktop shell only', () => {
    // Navigation, direct routes and search all read this one predicate (SettingsView.tsx
    // isPageAvailable, search.ts buildSettingsSearchResults), so hiding the page here hides
    // every way to reach it.
    const tunnel = getSettingsPageMeta('tunnel');
    const base = { isVSCode: false, isWeb: false, isMobile: false };
    expect(tunnel?.isAvailable?.({ ...base, isDesktop: true })).toBe(false);
    expect(tunnel?.isAvailable?.({ ...base, isDesktop: false, isWeb: true })).toBe(true);
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
});
