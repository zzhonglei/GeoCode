import { isDesktopShell } from '@/lib/desktop';

// UI entry points for mechanisms the main process and the server refuse in the desktop app are hidden behind this.
export const isGeoCodeDesktop = (): boolean => isDesktopShell();
