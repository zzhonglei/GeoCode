import { describe, expect, test } from 'bun:test';

import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '@/lib/i18n/messages/zh-TW';
import type { Locale } from '@/lib/i18n/runtime';
import { useI18nStore, type I18nDictionary } from '@/lib/i18n/store';
import { toGeoCodeDictionary } from './brand';

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
