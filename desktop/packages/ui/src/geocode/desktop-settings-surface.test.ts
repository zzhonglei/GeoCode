/* --- GeoCode: the "OpenCode CLI" settings section stays off the desktop shell
 * (docs/DESKTOP.md §7.3).
 *
 * Two halves have to agree: the page must not render the section, and the settings search
 * must not offer entries that lead to it. The filter is a pure function pinned here; the two
 * call sites are pinned by reading their source, because a renderer test that mounts the
 * settings page would drag every store along and prove less than it costs. --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS, isSettingsSearchItemHiddenOnDesktop } from './desktop-settings-surface';

const read = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

describe('desktop settings surface', () => {
  test('the two OpenCode CLI search entries are hidden in the desktop shell only', () => {
    for (const id of HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS) {
      expect(isSettingsSearchItemHiddenOnDesktop(id, true)).toBe(true);
      expect(isSettingsSearchItemHiddenOnDesktop(id, false)).toBe(false);
    }
    expect(isSettingsSearchItemHiddenOnDesktop('sessions.desktop-lan-access', true)).toBe(false);
  });

  test('the hidden ids are the ids the search table declares', () => {
    const search = read('lib/settings/search.ts');
    for (const id of HIDDEN_DESKTOP_SETTINGS_SEARCH_IDS) {
      expect(search).toContain(`id: '${id}'`);
    }
    expect(search).toContain('isSettingsSearchItemHiddenOnDesktop(item.id, isDesktopShell())');
  });

  test('the settings page renders the section through the desktop guard only', () => {
    const page = read('components/sections/openchamber/OpenChamberPage.tsx');
    expect(page).toContain("import { OpenCodeCliSettings as UpstreamOpenCodeCliSettings } from './OpenCodeCliSettings'");
    expect(page).toContain('isDesktopShell() ? null : <UpstreamOpenCodeCliSettings />');
    // The upstream JSX sites keep their name, so they resolve to the guarded component above.
    expect(page.match(/<OpenCodeCliSettings \/>/g)?.length).toBe(2);
    expect(page.match(/<UpstreamOpenCodeCliSettings \/>/g)?.length).toBe(1);
  });
});
