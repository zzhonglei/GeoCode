import React from 'react';
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { fetchStartupDiagnostics, type StartupDiagnostics } from '@/lib/startupDiagnostics';
import type { InitFailure } from '@/stores/useConfigStore';

export type StartupCause = 'kernel' | 'settings' | 'service' | 'install' | 'geoengine';

/** What the local service reports outranks what the interface guessed from its own failed step. */
export const startupCause = (step: InitFailure['step'] | undefined, reported: StartupDiagnostics | null): StartupCause => {
  // A kernel that was started and failed has a path; one that was never found has none.
  if (reported && !reported.binary) return 'install';
  if (step === 'serverUnreachable') return 'service';
  if (step === 'loadAgents' && !reported) return 'settings';
  return 'kernel';
};

const DIAGNOSTICS_REQUEST_MS = 5000;

export const readStartupDiagnostics = async (signal: AbortSignal): Promise<StartupDiagnostics | null> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  const timeout = setTimeout(abort, DIAGNOSTICS_REQUEST_MS);
  try {
    return await fetchStartupDiagnostics(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
};

// Set by the local service once every attempt of the initial launch has failed (web/server/index.js).
const startFailedSchema = z.object({ geocodeKernelStartFailed: z.boolean().optional() });

const fetchKernelStartFailed = async (signal: AbortSignal): Promise<boolean> => {
  const response = await runtimeFetch('/health', { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  return response.ok && startFailedSchema.parse(await response.json()).geocodeKernelStartFailed === true;
};

const START_FAILURE_POLL_MS = 3000;

/**
 * Whether the local service reports that the kernel failed to start. Upstream shows its recovery screen only after
 * about two minutes of retries; the service knows as soon as the attempts of the initial launch are over.
 */
export const useKernelStartFailed = (watching: boolean): boolean => {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!watching) {
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    const poll = async () => {
      const reported = await fetchKernelStartFailed(controller.signal).catch(() => false);
      if (reported && !controller.signal.aborted) setFailed(true);
    };
    const timer = setInterval(() => { void poll(); }, START_FAILURE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [watching]);

  return failed;
};
