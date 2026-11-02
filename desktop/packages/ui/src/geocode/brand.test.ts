import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';

import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '@/lib/i18n/messages/zh-TW';
import type { Locale } from '@/lib/i18n/runtime';
import { useI18nStore, type I18nDictionary } from '@/lib/i18n/store';
import { toGeoCodeDiagnosticLog, toGeoCodeDictionary } from './brand';

// Guards against a merge bringing text that names OpenChamber or OpenCode to a screen the user can reach.
const UPSTREAM = /openchamber|opencode/i;
const SERVICES = /OpenCode (?:Zen|Go|Console|Web Search)/g;

// Screens GeoCode closes, where upstream's technical names (commands, paths, link schemes) remain.
const CLOSED = [
  'settings.remoteInstances.',
  'settings.classification.',
  'settings.plugins.',
  'settings.view.home.cards.plugins.',
  'settings.snippets.',
  'settings.openchamber.tunnel.',
  'settings.openchamber.opencodeCli.',
  'settings.projects.shared.',
  'settings.projects.actionEditor.savedIn.',
  'settings.projects.actions.confirmDelete.',
  'settings.skills.catalog.',
  'settings.extensions.browse.',
  'settings.skills.sidebar.badge.opencode',
  'onboarding.localSetup.',
  'updateDialog.',
];

// Named when the kernel is assembled, together with the commands it carries: the badge of the kernel's built-in commands.
const LATER = ['chat.autocomplete.scope.opencode'];

const dictionaries: [Locale, I18nDictionary][] = [['en', en], ['zh-CN', zhCN], ['zh-TW', zhTW]];

describe('GeoCode: names in the interface', () => {
  for (const [locale, dictionary] of dictionaries) {
    test(`names neither upstream in ${locale} outside closed screens`, () => {
      const named = Object.entries(toGeoCodeDictionary(locale, dictionary))
        .filter(([key, text]) => UPSTREAM.test(text.replace(SERVICES, '')) && !CLOSED.some((prefix) => key.startsWith(prefix)) && !LATER.includes(key))
        .map(([key]) => key);
      expect(named).toEqual([]);
    });

    // Upstream's OpenCode there is the kernel, and its version is the kernel's, not GeoCode's.
    test(`calls the kernel the kernel in the memory snapshot in ${locale}`, () => {
      const named = Object.entries(toGeoCodeDictionary(locale, dictionary))
        .filter(([key, text]) => key.startsWith('openCodeStatusDialog.heapSnapshot.') && text.includes('GeoCode'))
        .map(([key]) => key);
      expect(named).toEqual([]);
    });

    // The app has no isolated spaces, so the tab setting names only what it does have.
    test(`names no space in the setting for tabs of their own in ${locale}`, () => {
      const named = Object.entries(toGeoCodeDictionary(locale, dictionary))
        .filter(([key, text]) => key.startsWith('settings.openchamber.visual.field.sessionTabsPerWorkspace') && /space|空间|空間/i.test(text))
        .map(([key]) => key);
      expect(named).toEqual([]);
    });
  }

  test('reaches the dictionary the interface reads', () => {
    expect(useI18nStore.getState().dictionary['settings.view.nav.group.general']).toBe('GeoCode');
  });
});

// Guards against the diagnostic timeline showing upstream's name and the shell's version as the app's.
describe('GeoCode: the diagnostic timeline', () => {
  test("names GeoCode with its own version, then the shell's, and calls OpenCode the kernel", () => {
    const timeline = [
      'OpenChamber diagnostic timeline',
      'OpenChamber: 2.4.0 (desktop)',
      'OpenCode: 2.2.5, binary source=bundled, wrapper=none',
      'Last OpenCode start error: none',
      '- OpenCode log files and output: not read',
      'OpenCode load: 2 loaded directories, 5 child processes using 310 MB, OpenCode itself 420 MB',
      'OpenCode load: 1 loaded directory, processes not counted (Windows, or OpenCode not on this machine)',
    ].join('\n');
    expect(toGeoCodeDiagnosticLog(timeline, '1.0.0').split('\n')).toEqual([
      'GeoCode diagnostic timeline',
      'GeoCode version: 1.0.0 (shell 2.4.0, desktop)',
      'Kernel: 2.2.5, binary source=bundled, wrapper=none',
      'Last kernel start error: none',
      '- Kernel log files and output: not read',
      'Kernel load: 2 loaded directories, 5 child processes using 310 MB, the kernel itself 420 MB',
      'Kernel load: 1 loaded directory, processes not counted (Windows, or the kernel not on this machine)',
    ]);
  });

  test('is written in the form toGeoCodeDiagnosticLog reads', () => {
    const source = fs.readFileSync(new URL('../lib/diagnostics/export.ts', import.meta.url), 'utf8');
    expect(source).toContain("`OpenChamber: ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'} (${canUseElectronDesktopIPC() ? 'desktop' : 'web'})`");
    expect(source).toContain('\\nOpenCode load: ${load}\\n');
    expect(source).toContain("'processes not counted (Windows, or OpenCode not on this machine)'");
    expect(source).toContain('OpenCode itself ${load.processes.openCodeMb} MB`');
  });
});
