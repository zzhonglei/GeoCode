import React from 'react';
import { addProtocol, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { BASEMAP_SCHEME, readBasemapResource, readBasemapStyle, type BasemapTheme } from './basemapClient';
import { useGeoStatuses } from './geoEngineClient';
import { basemapStatusOf } from './geoStatus';
import { toGeoCodeLocale } from './languages';

// Here, as every map of the app draws a basemap and so imports this module: the file preview's and the settings'.
setWorkerUrl(workerUrl);

// The icons' index is asked for as JSON, the rest as bytes.
addProtocol(BASEMAP_SCHEME, async (parameters, abortController) => {
  const data = await readBasemapResource(parameters.url, abortController.signal);
  return { data: parameters.type === 'json' ? JSON.parse(new TextDecoder().decode(data)) : data };
});

/** The interface's theme as the basemap draws it; light where no theme is set. */
export const useBasemapTheme = (): BasemapTheme => (useOptionalThemeSystem()?.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light');

/**
 * The basemap's style for the interface as it is now, read again when the theme, the language or the settings' choice
 * changes; undefined while it is read, null for none, as when an online basemap cannot be reached.
 */
export const useBasemapStyle = (): StyleSpecification | null | undefined => {
  const theme = useBasemapTheme();
  const locale = toGeoCodeLocale(useI18n().locale);
  // Read again whenever the choice changes, as for another style or another layer of Tianditu's; the offline basemap
  // until GeoEngine says otherwise, so the style is not read twice as the app starts.
  const status = basemapStatusOf(useGeoStatuses());
  const choice = status
    ? [status.source, status.openfreemap, status.versatiles, status.tianditu, status.custom ?? null]
    : ['offline'];
  const key = JSON.stringify([theme, locale, ...choice]);
  const [read, setRead] = React.useState<{ key: string; style: StyleSpecification | null }>();
  React.useEffect(() => {
    let live = true;
    void readBasemapStyle(theme, locale)
      .catch(() => {
        // A map without its basemap still shows the data; the shell server's log tells why.
        console.warn('GeoCode could not read the basemap');
        return null;
      })
      .then((style) => {
        if (live) setRead({ key, style });
      });
    return () => {
      live = false;
    };
  }, [key, theme, locale]);
  return read?.key === key ? read.style : undefined;
};
