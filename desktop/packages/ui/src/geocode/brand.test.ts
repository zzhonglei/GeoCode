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

const dictionaries: [Locale, I18nDictionary][] = [['en', en], ['zh-CN', zhCN], ['zh-TW', zhTW]];

describe('GeoCode: names in the interface', () => {
  for (const [locale, dictionary] of dictionaries) {
    test(`names neither upstream in ${locale} outside closed screens`, () => {
      const named = Object.entries(toGeoCodeDictionary(locale, dictionary))
        .filter(([key, text]) => UPSTREAM.test(text.replace(SERVICES, '')) && !CLOSED.some((prefix) => key.startsWith(prefix)))
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
    ].join('\n');
    expect(toGeoCodeDiagnosticLog(timeline, '1.0.0').split('\n')).toEqual([
      'GeoCode diagnostic timeline',
      'GeoCode version: 1.0.0 (shell 2.4.0, desktop)',
      'Kernel: 2.2.5, binary source=bundled, wrapper=none',
      'Last kernel start error: none',
      '- Kernel log files and output: not read',
    ]);
  });

  test('is written in the form toGeoCodeDiagnosticLog reads', () => {
    const source = fs.readFileSync(new URL('../lib/diagnostics/export.ts', import.meta.url), 'utf8');
    expect(source).toContain("`OpenChamber: ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'} (${canUseElectronDesktopIPC() ? 'desktop' : 'web'})`");
  });
});
