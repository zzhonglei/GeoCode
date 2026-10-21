import type React from 'react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { StartupFailure } from './StartupFailure';
import { geoEngineFailureText, useGeoEngineFailure } from './geoengine';
import { usePythonGate } from './geoEngineClient';

/**
 * The mini chat window's failure pages for GeoEngine and the Python environment; App shows the main window's itself.
 * Only the main window's loading screen waits for the environment.
 */
export const GeoEngineGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const failure = useGeoEngineFailure();
  const python = usePythonGate();
  if (failure) return <ErrorBoundary><StartupFailure cause="geoengine" error={geoEngineFailureText(failure)} /></ErrorBoundary>;
  if (python.state === 'failed') return <ErrorBoundary><StartupFailure cause="python" error={python.error} /></ErrorBoundary>;
  return children;
};
