/* --- GeoCode: the desktop shell has no host switcher, so nothing mounts one, nothing warms its
 * statuses and no shortcut list offers its toggle (docs/DESKTOP.md §7.3).
 *
 * The warm-up runs unprompted after every launch, so it is run here against a stand-in for the
 * desktop bridge. The mount sites are pinned by source, as the header menu is in
 * desktop-settings-surface.test.ts. --- */
import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDesktopShell } from '../lib/desktop';
import { warmDesktopHostStatuses } from '../lib/desktopHostStatus';
import { getCustomizableShortcutActions } from '../lib/shortcuts';
import { isShortcutHiddenOnDesktop } from './host-switcher-surface';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scope = globalThis as { window?: unknown };
const previousWindow = scope.window;

afterAll(() => {
  scope.window = previousWindow;
});

const componentFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [full] : [];
  });

describe('host switcher surface', () => {
  test('the warm-up after launch sends no host probe from the desktop shell', async () => {
    const invoked: string[] = [];
    scope.window = {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: {
        invoke: async (command: string) => {
          invoked.push(command);
          return command === 'desktop_hosts_get'
            ? { hosts: [], defaultHostId: 'local', initialHostChoiceCompleted: true, localOrigin: 'http://127.0.0.1:1' }
            : null;
        },
      },
    };
    expect(isDesktopShell()).toBe(true);
    await warmDesktopHostStatuses();
    expect(invoked).not.toContain('desktop_host_probe');
  });

  test('the sign-in gate and the header are the only mounts, and the gate never shows it', () => {
    const mounts = componentFiles(SRC)
      .filter((file) => /<DesktopHostSwitcher(Inline|Dialog)\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(mounts).toEqual([
      'components/auth/SessionAuthGate.tsx',
      'components/desktop/DesktopHostSwitcher.tsx',
      'components/layout/Header.tsx',
    ]);
    const gate = readFileSync(path.join(SRC, 'components/auth/SessionAuthGate.tsx'), 'utf8');
    expect(gate).toContain('const showHostSwitcher = false;');
    const switchers = [...gate.matchAll(/<DesktopHostSwitcherInline/g)].map((match) => match.index ?? -1);
    expect(switchers.length).toBeGreaterThan(0);
    for (const at of switchers) {
      expect(gate.lastIndexOf('{showHostSwitcher && (', at)).toBeGreaterThan(gate.lastIndexOf(')}', at));
    }
  });

  test('the shortcut that toggles the switcher is not listed in the desktop shell', () => {
    // Pressing it only flips the state of a menu the desktop shell never mounts.
    expect(getCustomizableShortcutActions().some((action) => action.id === 'toggle_services_menu')).toBe(true);
    expect(isShortcutHiddenOnDesktop('toggle_services_menu', true)).toBe(true);
    expect(isShortcutHiddenOnDesktop('toggle_services_menu', false)).toBe(false);
    const listings = componentFiles(SRC)
      .filter((file) => /getCustomizableShortcutActions\(|getShortcutAction\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(listings).toEqual([
      'components/sections/openchamber/KeyboardShortcutsSettings.tsx',
      'components/ui/HelpDialog.tsx',
    ]);
    for (const file of listings) {
      expect(readFileSync(path.join(SRC, file), 'utf8')).toContain('!isShortcutHiddenOnDesktop(');
    }
  });
});
