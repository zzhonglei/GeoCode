import { menuLabel as upstreamMenuLabel } from '../menu-locales.mjs';

// Upstream's menu dictionaries name OpenChamber in every language; the menus name GeoCode instead.
export const menuLabel = (locale, key) => upstreamMenuLabel(locale, key).replaceAll('OpenChamber', 'GeoCode');
