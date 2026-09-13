/* --- GeoCode: whether the kernel went away after this window opened (docs/DESKTOP.md §5.2).
 *
 * The main process records it and announces it (electron/geocode/kernel-failure.mjs). Asking once
 * as well covers a kernel that died before this window was listening. --- */
import * as React from 'react';

import { invokeDesktop } from '@/lib/desktop';
import type { KernelFailure } from './GeoCodeKernelFailureScreen';

/** Mirrors `KERNEL_LOST_EVENT` in electron/geocode/kernel-failure.mjs, which pins the copy. */
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
