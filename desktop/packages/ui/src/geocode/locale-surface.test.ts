/* --- GeoCode: only the three product languages can be reached, by picking one or by having one
 * stored (docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { useI18nStore } from '../lib/i18n/store';
import type { Locale } from '../lib/i18n/runtime';
import { OFFERED_LOCALES, coerceOfferedLocale } from './locale-surface';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('offered locales', () => {
  test('the product languages are the ones the locale tripwires scan', () => {
    expect([...OFFERED_LOCALES]).toEqual(['en', 'zh-CN', 'zh-TW']);
    const paths = read('geocode/locale-paths.test.ts');
    for (const locale of OFFERED_LOCALES) {
      expect([locale, paths.includes(`messages/${locale}`)]).toEqual([locale, true]);
    }
  });

  test('a language outside them starts English instead', () => {
    // A language stored by an earlier build takes this path at startup.
    for (const upstream of ['de', 'ja', 'pt-BR'] as Locale[]) {
      expect([upstream, coerceOfferedLocale(upstream)]).toEqual([upstream, 'en']);
      useI18nStore.getState().setLocale(upstream);
      expect([upstream, useI18nStore.getState().locale]).toEqual([upstream, 'en']);
    }
  });

  test('the product languages still apply', () => {
    useI18nStore.getState().setLocale('zh-TW');
    expect(useI18nStore.getState().locale).toBe('zh-TW');
    useI18nStore.getState().setLocale('en');
    expect(useI18nStore.getState().locale).toBe('en');
  });

  test('the Appearance picker offers only them', () => {
    // Asserted over the source: the store above cannot see a picker that stopped filtering.
    const visual = read('components/sections/openchamber/OpenChamberVisualSettings.tsx');
    expect(visual).toContain('{locales.filter(isOfferedLocale).map((availableLocale) => (');
    expect(visual).not.toContain('{locales.map((availableLocale) => (');
  });
});
