import { isDesktopShell } from '@/lib/desktop';

// The embedded session chat is a same-origin frame without the preload, so it asks the window that holds it.
const isInDesktopFrame = (): boolean => {
  try {
    return window.parent !== window && window.parent.__OPENCHAMBER_ELECTRON__?.runtime === 'electron';
  } catch {
    return false;
  }
};

// UI entry points for mechanisms the main process and the server refuse in the desktop app are hidden behind this.
export const isGeoCodeDesktop = (): boolean => isDesktopShell() || isInDesktopFrame();

const CLOSED_SURFACES = new Set(['linear']);

export const withoutClosedSurfaces = <T extends { id: string }>(surfaces: readonly T[]): readonly T[] =>
  isGeoCodeDesktop() ? surfaces.filter((surface) => !CLOSED_SURFACES.has(surface.id)) : surfaces;
