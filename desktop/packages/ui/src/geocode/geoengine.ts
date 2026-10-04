import React from 'react';

import { invokeDesktop } from '@/lib/desktop';

/** Why GeoEngine stopped, as the main process records it. */
export type GeoEngineFailure = {
  reason: 'missing' | 'start' | 'exit';
  message: string;
  exitCode?: number | null;
  output: string;
};

const FAILED_EVENT = 'geocode:geoengine-failed';

export const geoEngineFailureText = (failure: GeoEngineFailure): string =>
  [failure.message, failure.output].filter(Boolean).join('\n\n');

/** Null while GeoEngine runs. It is not started again, so a failure lasts until the app restarts. */
export const useGeoEngineFailure = (): GeoEngineFailure | null => {
  const [failure, setFailure] = React.useState<GeoEngineFailure | null>(null);

  React.useEffect(() => {
    let active = true;
    // The event carries nothing: the main process keeps the failure, so a window opened later reads it the same way.
    const read = () => {
      void invokeDesktop<GeoEngineFailure | null>('geocode_geoengine_failure').then((value) => {
        if (active && value) setFailure(value);
      }).catch((error) => {
        console.warn('[geocode] could not read whether GeoEngine failed:', error);
      });
    };
    read();
    window.addEventListener(FAILED_EVENT, read);
    return () => {
      active = false;
      window.removeEventListener(FAILED_EVENT, read);
    };
  }, []);

  return failure;
};
