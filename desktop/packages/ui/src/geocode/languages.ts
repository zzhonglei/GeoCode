import type { Locale } from '@/lib/i18n/runtime';

const GEOCODE_LOCALES: readonly Locale[] = ['en', 'zh-CN', 'zh-TW'];

export const onlyGeoCodeLocales = (locales: readonly Locale[]): readonly Locale[] =>
  locales.filter((locale) => GEOCODE_LOCALES.includes(locale));

// Stored values may predate this list or come from an OpenChamber sharing this storage.
export const toGeoCodeLocale = (locale: Locale): Locale => (GEOCODE_LOCALES.includes(locale) ? locale : 'en');
