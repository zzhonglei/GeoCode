import type { BasemapStatus } from './geoStatus';

/** A style's colours, sketched in the small disc beside its name: its land, its water and a main road. */
export type Swatch = { readonly land: string; readonly water: string; readonly road: string };

/**
 * Near the colours each style draws in a light interface, to tell the styles apart at a glance; the preview below them
 * shows the real map, in the interface's theme.
 */
export const SWATCHES = {
  openfreemap: {
    liberty: { land: '#f8f4f0', water: '#a0c8f0', road: '#fcd6a4' },
    bright: { land: '#f8f4f0', water: '#8ab9ea', road: '#ffbe6f' },
    positron: { land: '#f2f3f0', water: '#c4cbcd', road: '#ffffff' },
    fiord: { land: '#45516e', water: '#36405a', road: '#7e8aa8' },
  },
  versatiles: {
    colorful: { land: '#f9f4ee', water: '#bcdcf2', road: '#ffcc88' },
    gray: { land: '#f2f2f2', water: '#cdcdcd', road: '#e6e6e6' },
    muted: { land: '#ebe8e1', water: '#b7c5cb', road: '#e6d8be' },
  },
  tianditu: {
    vec: { land: '#f3efe3', water: '#9fc5e8', road: '#ffd36e' },
    img: { land: '#55603e', water: '#14304a', road: '#e8d48f' },
    ter: { land: '#ece4cf', water: '#a9cde7', road: '#f6c97a' },
  },
} satisfies {
  openfreemap: Record<BasemapStatus['openfreemap'], Swatch>;
  versatiles: Record<BasemapStatus['versatiles'], Swatch>;
  tianditu: Record<BasemapStatus['tianditu']['layer'], Swatch>;
};
