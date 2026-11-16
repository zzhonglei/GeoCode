import type { StyleSpecification } from 'maplibre-gl';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The basemap under the app's maps, as GeoEngine serves it (geoengine/src/basemap/index.ts) through the shell server's
 * routes (web/server/geocode/geo-preview.js): a MapLibre style in the interface's theme and language, whose tiles and
 * icons it names by SCHEME.
 */
export const BASEMAP_SCHEME = 'geocode-basemap';

const BASEMAP_PATH = '/api/geocode/basemap';

export type BasemapTheme = 'light' | 'dark';

// What the style names, and nothing else: a page in the chat asks for these by an address it writes itself, and the
// window asks the shell server with its own credentials.
const RESOURCE = new RegExp(`^${BASEMAP_SCHEME}://(?:((?:vector|relief)/\\d+/\\d+/\\d+)|(sprite/ofm(?:@2x)?\\.(?:json|png)))$`);

/** The bytes of a tile or an icon file the style names; empty where the basemap has nothing. */
export const readBasemapResource = async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
  const named = RESOURCE.exec(url);
  if (!named) throw new Error(`${url} is no part of the basemap`);
  const asked = named[1] ? `${BASEMAP_PATH}/tile/${named[1]}` : `${BASEMAP_PATH}/${named[2]}`;
  const response = await runtimeFetch(asked, { signal });
  if (response.status === 204) return new ArrayBuffer(0);
  if (!response.ok) throw new Error(`The basemap could not be read (${response.status})`);
  return response.arrayBuffer();
};

/** The style for the settings' basemap, or null when they choose none. */
export const readBasemapStyle = async (theme: BasemapTheme, locale: string): Promise<StyleSpecification | null> => {
  const response = await runtimeFetch(`${BASEMAP_PATH}/style`, { query: { theme, locale } });
  if (!response.ok) throw new Error(`The basemap could not be read (${response.status})`);
  // SAFETY: basemap.style in geoengine/src/basemap/index.ts answers with a MapLibre style, or null.
  const body = (await response.json()) as { style: StyleSpecification | null };
  return body.style;
};

