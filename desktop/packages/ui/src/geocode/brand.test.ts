import { describe, expect, test } from 'bun:test';

import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '@/lib/i18n/messages/zh-TW';
import type { Locale } from '@/lib/i18n/runtime';
import { useI18nStore, type I18nDictionary } from '@/lib/i18n/store';
import { toGeoCodeDictionary, toGeoCodeReport, toGeoCodeText, withoutUpstreamSite } from './brand';

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
  'settings.skills.catalog.',
  'settings.skills.sidebar.badge.opencode',
  'onboarding.localSetup.',
  'updateDialog.',
];

const dictionaries: [Locale, I18nDictionary][] = [['en', en], ['zh-CN', zhCN], ['zh-TW', zhTW]];

describe('GeoCode: names in the interface', () => {
  test('keeps the names of the services OpenCode runs', () => {
    expect(toGeoCodeText('OpenCode sends keys to OpenCode Zen, not to an OpenChamber server.')).toBe('GeoCode sends keys to OpenCode Zen, not to a GeoCode server.');
  });

  for (const [locale, dictionary] of dictionaries) {
    test(`names neither upstream in ${locale} outside closed screens`, () => {
      const named = Object.entries(toGeoCodeDictionary(locale, dictionary))
        .filter(([key, text]) => UPSTREAM.test(text.replace(SERVICES, '')) && !CLOSED.some((prefix) => key.startsWith(prefix)))
        .map(([key]) => key);
      expect(named).toEqual([]);
    });
  }

  test('offers no link into the sites of OpenCode and OpenChamber', () => {
    expect(withoutUpstreamSite('https://opencode.ai/docs/agents/#build')).toBeUndefined();
    expect(withoutUpstreamSite('https://docs.openchamber.dev/walkthrough/')).toBeUndefined();
    expect(withoutUpstreamSite('https://example.org/opencode.ai/')).toBe('https://example.org/opencode.ai/');
  });

  test('renames the labels of a status report and leaves its values', () => {
    expect(toGeoCodeReport([
      'OpenCode runtime port: 4096',
      '- OpenChamber desktop: ~/Library/Logs/GeoCode/main.log',
      'Secure OpenCode connection: true',
      '- last error: spawn /Users/me/OpenCode/bin ENOENT',
    ])).toEqual([
      'Kernel runtime port: 4096',
      '- GeoCode desktop: ~/Library/Logs/GeoCode/main.log',
      'Secure kernel connection: true',
      '- last error: spawn /Users/me/OpenCode/bin ENOENT',
    ]);
  });

  test('reaches the dictionary the interface reads', () => {
    expect(useI18nStore.getState().dictionary['settings.view.nav.group.general']).toBe('GeoCode');
  });
});
