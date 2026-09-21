/* --- GeoCode: independent renderer roots also need the kernel failure record and event (docs/DESKTOP.md §5.2). --- */
import type { ReactNode } from 'react';
import { GeoCodeKernelFailureScreen } from './GeoCodeKernelFailureScreen';
import { useKernelLost } from './kernel-lost';

export const GeoCodeKernelFailureGate = ({ children }: { children: ReactNode }) =>
  useKernelLost(true) ? <GeoCodeKernelFailureScreen /> : children;
