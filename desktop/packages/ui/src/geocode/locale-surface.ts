/* --- GeoCode: the interface speaks three languages (docs/DESKTOP.md §7.3).
 *
 * Upstream's other nine dictionaries were never rebranded and name paths GeoCode does not have.
 * The Appearance picker offers only these, and `setLocale` coerces a stored one outside them. --- */
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/runtime';

/** The product languages: the ones GeoCode translates and the locale tripwires scan. */
export const OFFERED_LOCALES = ['en', 'zh-CN', 'zh-TW'] as const satisfies readonly Locale[];

export const isOfferedLocale = (locale: Locale): boolean =>
  (OFFERED_LOCALES as readonly Locale[]).includes(locale);

export const coerceOfferedLocale = (locale: Locale): Locale =>
  (isOfferedLocale(locale) ? locale : DEFAULT_LOCALE);
