import type React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { StartupFailure } from './StartupFailure';
import { geoEngineFailureText, useGeoEngineFailure } from './geoengine';

/** The mini chat window's GeoEngine failure page; App shows the main window's itself. */
export const GeoEngineGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const failure = useGeoEngineFailure();
  if (failure) return <ErrorBoundary><StartupFailure cause="geoengine" error={geoEngineFailureText(failure)} /></ErrorBoundary>;
  return children;
};
