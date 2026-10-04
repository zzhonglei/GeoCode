import React from 'react';

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

const START_FAILURE_POLL_MS = 3000;
const START_FAILURE_CONFIRMATIONS = 2;

/**
 * Whether the local service reports that the kernel failed to start. Upstream shows its recovery screen only after
 * about two minutes of retries; a kernel that is merely slow reports no error, and one failed attempt can be followed
 * by a successful one, so the error has to be reported twice in a row.
 */
export const useKernelStartFailed = (watching: boolean): boolean => {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!watching) {
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    let confirmations = 0;
    const poll = async () => {
      const diagnostics = await readStartupDiagnostics(controller.signal);
      if (controller.signal.aborted) return;
      confirmations = diagnostics?.error ? confirmations + 1 : 0;
      if (confirmations >= START_FAILURE_CONFIRMATIONS) setFailed(true);
    };
    const timer = setInterval(() => { void poll(); }, START_FAILURE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [watching]);

  return failed;
};
