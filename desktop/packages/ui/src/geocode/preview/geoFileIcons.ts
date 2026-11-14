import { geoDataFormat, type GeoDataFormat } from './geoFiles';

/**
 * File-type icons for the files that open as a map, drawn as the upstream icons are (one 24 by 24 shape, flat fills)
 * in the colours of a map: land, water, a place marker and a hypsometric ramp. They are symbols in a sprite of their
 * own, beside the upstream sprite, so the upstream one stays as it ships. They reach the app only through upstream's
 * getFileTypeIconHref in lib/fileTypeIcons.ts, whose callers take its result as an in-document `#id` (UserTextPart
 * drops the `#`): a caller that resolves file icons another way shows a geographic file with upstream's icon.
 */

type Variant = 'dark' | 'light';

const SPRITE_ID = 'geocode-geo-file-icons';

type MapColors = { land: string; water: string; pin: string; terrain: string };

const COLORS = {
  dark: { land: '#66bb6a', water: '#42a5f5', pin: '#ef5350', terrain: '#bcaaa4' },
  light: { land: '#43a047', water: '#1e88e5', pin: '#e53935', terrain: '#8d6e63' },
} satisfies Record<Variant, MapColors>;

// Low to high: water, lowland, upland, hills, mountains.
const RAMP = ['#1e88e5', '#43a047', '#9ccc65', '#fdd835', '#a1887f'];

const JSON_AMBER = '#f9a825';

const line = (color: string) => `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

const PARCEL: Array<[number, number]> = [[5, 7.5], [15.5, 4.5], [19.5, 14], [9.5, 19.5]];

const DRAWINGS = {
  // A parcel with its vertices on a map's water.
  shp: ({ land, water }: MapColors) => [
    `<rect x="1.5" y="1.5" width="21" height="21" rx="3" fill="${water}" fill-opacity=".28"/>`,
    `<polygon points="${PARCEL.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${land}" fill-opacity=".5" stroke="${land}" stroke-width="2" stroke-linejoin="round"/>`,
    ...PARCEL.map(([x, y]) => `<rect x="${x - 2.25}" y="${y - 2.25}" width="4.5" height="4.5" rx=".9" fill="${land}"/>`),
  ].join(''),
  // Cells coloured by height, rising from the lower left.
  tif: () => [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => (
    `<rect x="${3 + column * 6}" y="${3 + row * 6}" width="6" height="6" fill="${RAMP[2 - row + column]}"/>`
  ))).join(''),
  // A place marker between JSON's braces.
  geojson: ({ pin }: MapColors) => [
    `<path d="M7.5 3.5C5.3 3.5 5 4.6 5 6.5v3.1C5 11 4.3 12 2.8 12 4.3 12 5 13 5 14.4v3.1c0 1.9.3 3 2.5 3M16.5 3.5c2.2 0 2.5 1.1 2.5 3v3.1c0 1.4.7 2.4 2.2 2.4-1.5 0-2.2 1-2.2 2.4v3.1c0 1.9-.3 3-2.5 3" ${line(JSON_AMBER)}/>`,
    `<path d="M12 5.6c-2.3 0-4 1.8-4 4.1 0 3.1 4 8.3 4 8.3s4-5.2 4-8.3c0-2.3-1.7-4.1-4-4.1Zm0 2.7a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 1 0 0-2.9Z" fill="${pin}" fill-rule="evenodd"/>`,
  ].join(''),
  // Layers stacked: land over water over terrain.
  gpkg: ({ land, water, terrain }: MapColors) => [
    `<path d="M2.5 16.5 12 21.5 21.5 16.5" ${line(terrain)}/>`,
    `<path d="M2.5 12 12 17 21.5 12" ${line(water)}/>`,
    `<path d="M12 2.5 21.5 7.5 12 12.5 2.5 7.5Z" fill="${land}"/>`,
  ].join(''),
} satisfies Record<GeoDataFormat, (colors: MapColors) => string>;

const symbolId = (format: string, variant: string): string => `geocode-${format}${variant === 'light' ? '_light' : ''}`;

const mountSprite = (): void => {
  if (document.getElementById(SPRITE_ID)) return;
  const symbols = Object.entries(DRAWINGS).flatMap(([format, draw]) => Object.entries(COLORS).map(([variant, colors]) => (
    `<symbol id="${symbolId(format, variant)}" viewBox="0 0 24 24">${draw(colors)}</symbol>`
  )));
  const root = document.createElement('div');
  root.id = SPRITE_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.position = 'absolute';
  root.style.width = '0';
  root.style.height = '0';
  root.style.overflow = 'hidden';
  root.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">${symbols.join('')}</svg>`;
  document.body.appendChild(root);
};

/** The `<use>` reference of a geographic file's icon, or null for any other file. */
export const geoFileIconHref = (path: string, variant: Variant = 'dark'): string | null => {
  const format = geoDataFormat(path);
  if (!format) return null;
  mountSprite();
  return `#${symbolId(format, variant)}`;
};
