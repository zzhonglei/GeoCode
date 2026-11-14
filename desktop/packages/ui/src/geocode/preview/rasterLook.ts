import { BY_CLASS, type GeoLook, type GeoStatistics, type Measured } from './previewClient';

export type Range = [number, number];
export type Classes = NonNullable<GeoStatistics['classes']>;

// The ramp a band is drawn through when the preview names none.
export const PLAIN = 'grey';
// What a band of bytes is drawn between when it is drawn as it is.
export const BYTES: Range = [0, 255];

// What the three bands of a picture are drawn as, and the colours their lines and marks are drawn in: these are of
// the data, as the colours of a ramp are.
export const CHANNELS = ['#e03131', '#2f9e44', '#1971c2'] as const;
export const CHANNEL_NAMES = ['R', 'G', 'B'] as const;

export const classColour = (each: Classes[number]): string => `rgb(${each.color.slice(0, 3).join(' ')} / ${(each.color[3] ?? 255) / 255})`;

/**
 * The colours a ramp passes through, by its name, from its low end to its high or, `reversed`, from its high end to
 * its low; grey's where the reader offers no ramp of that name.
 */
export const rampColours = (statistics: GeoStatistics, ramp: string, reversed = false): readonly string[] => {
  const colours = statistics.ramps[ramp] ?? statistics.ramps[PLAIN] ?? ['#000000', '#ffffff'];
  return reversed ? [...colours].reverse() : colours;
};

/** How one band drawn alone is drawn: see `bandLook`. */
export type BandLook = { ramp: string; classed: boolean; range: Range | null; reversed: boolean };

/**
 * How one band drawn alone is drawn: through the ramp the preview names, or else by its classes where it has them
 * and else in grey, as the reader draws it when left to itself; and between the range the preview names, none to
 * draw it as it is, or else the one the reader chose for it; with its ramp `reversed` where the preview says, which
 * classes never are. `classes` are the band's, none of a band without them.
 */
export const bandLook = (band: Measured, classes: Classes | null, look: GeoLook | null): BandLook => {
  const ramp = look?.ramp ?? (classes ? BY_CLASS : PLAIN);
  const classed = classes !== null && ramp === BY_CLASS;
  return { ramp, classed, range: look && !classed ? (look.ranges?.[0] ?? null) : band.between, reversed: !classed && look?.reversed === true };
};

const channelsOf = (colour: string): number[] => [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));

/**
 * The colour a value of a band is drawn in through a ramp, between a range or as it is with none, worked out as the
 * reader works it out (`_ramp` and `tile` in geoengine/python/geocodekit/preview/_raster.py): the value scaled to
 * one of 256 steps, through which the ramp's colours run evenly.
 */
export const drawnColour = (value: number, range: Range | null, colours: readonly string[]): string => {
  const [low, high] = range ?? BYTES;
  const step = Math.floor(Math.min(255, Math.max(0, (value - low) * (255 / Math.max(high - low, 1e-12)))));
  if (colours.length < 2) return colours[0] ?? '#000000';
  const along = (step / 255) * (colours.length - 1);
  const at = Math.min(colours.length - 2, Math.floor(along));
  const [from, to] = [channelsOf(colours[at]), channelsOf(colours[at + 1])];
  return `rgb(${from.map((channel, index) => Math.round(channel + (to[index] - channel) * (along - at))).join(' ')})`;
};
