/* --- GeoCode: whether the kernel exited after it came up; the main process's record is read as well as its event,
 * which may have been sent before this window listened (docs/DESKTOP.md §5.2). --- */
import * as React from 'react';

import { invokeDesktop } from '@/lib/desktop';
import type { KernelFailure } from './GeoCodeKernelFailureScreen';

/** Mirrors `KERNEL_LOST_EVENT` in electron/geocode/kernel-failure.mjs; kernel-failure.test.mjs pins the copy. */
export const KERNEL_LOST_EVENT = 'geocode:kernel-lost';

export const useKernelLost = (enabled: boolean): boolean => {
  const [lost, setLost] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const markLost = () => {
      if (!cancelled) setLost(true);
    };
    window.addEventListener(KERNEL_LOST_EVENT, markLost);
    void invokeDesktop<KernelFailure | null>('geocode_kernel_failure')
      .then((record) => {
        if (record?.phase === 'running') markLost();
      })
      .catch(() => null);
    return () => {
      cancelled = true;
      window.removeEventListener(KERNEL_LOST_EVENT, markLost);
    };
  }, [enabled]);

  return lost;
};
