import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

// The shell server's routes for a preview, see web/server/geocode/geo-preview.js.
const PREVIEW_PATH = '/api/geocode/preview';

/** The address scheme the map asks for its tiles by; GeoMap answers it with the window's own requests. */
export const TILE_SCHEME = 'geocode-preview';

const crs = z.object({ name: z.string(), code: z.string().nullable() }).nullable();
const place = {
  stamp: z.string(),
  /** The layers the file holds, vector layers and rasters alike, and the one described. */
  layers: z.array(z.object({ name: z.string(), kind: z.enum(['vector', 'raster']) })),
  layer: z.string(),
  crs,
  /** West, south, east and north, in degrees. */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Why the data has no place on the map, in place of its bounds. */
  unplaced: z.string().optional(),
};

/** What a vector layer's features are drawn as; a layer of several is shown with any of them hidden. */
export const FORMS = ['points', 'lines', 'polygons'] as const;
export type Form = (typeof FORMS)[number];

const descriptionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('vector'),
    features: z.number(),
    geometry: z.string().nullable(),
    /** How many features are drawn as each, of a layer whose type does not say; null where the layer was not read. */
    forms: z.object({ points: z.number().optional(), lines: z.number().optional(), polygons: z.number().optional() }).nullable().optional(),
    fields: z.array(z.object({ name: z.string(), type: z.string() })),
    ...place,
  }),
  z.object({
    kind: z.literal('raster'),
    width: z.number(),
    height: z.number(),
    bands: z.array(z.object({ type: z.string(), color: z.string(), nodata: z.number().nullable() })),
    shown: z.array(z.number()),
    overviews: z.number(),
    ...place,
  }),
]);

export type GeoDescription = z.infer<typeof descriptionSchema>;
export type VectorDescription = Extract<GeoDescription, { kind: 'vector' }>;
export type RasterDescription = Extract<GeoDescription, { kind: 'raster' }>;
export type GeoBounds = NonNullable<GeoDescription['bounds']>;

/** An attribute's value as it is shown: text as it is, anything else as JSON writes it; no value stays none, told from empty text. */
const shownValue = z.union([z.string(), z.null(), z.unknown().transform((value) => JSON.stringify(value))]);

const foundSchema = z.object({
  found: z
    .object({
      fid: z.number(),
      /** Where the feature comes in the layer's table, counted from none. */
      row: z.number(),
      attributes: z.array(z.tuple([z.string(), shownValue])),
      /** West, south, east and north, in degrees; none of a feature without geometry. */
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    })
    .nullable(),
});

const measuredSchema = z.object({
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  std: z.number(),
  /** The values the band is drawn between unless the preview names others. */
  between: z.tuple([z.number(), z.number()]),
  /** How many values of the sample fall into each of as many even steps from `min` to `max`. */
  counts: z.array(z.number()),
});

const statisticsSchema = z.object({
  statistics: z.object({
    /** Each band as a sample of it measures; none of a band without data. */
    bands: z.array(measuredSchema.nullable()),
    /** What one band may be coloured through, each the colours it passes from its low end to its high. */
    ramps: z.record(z.string(), z.array(z.string())),
    /**
     * The classes of a band that has them, which it is drawn by unless the preview names a ramp: each with its
     * colour and the share of the raster that is of it.
     */
    classes: z.array(z.object({ value: z.number(), color: z.array(z.number()), share: z.number(), name: z.string().nullable() })).optional(),
    /** The classes' shares are of a sample of the raster, which is too large to count through. */
    sampled: z.boolean().optional(),
  }),
});

export type GeoStatistics = z.infer<typeof statisticsSchema>['statistics'];
export type Measured = z.infer<typeof measuredSchema>;

/**
 * How the preview has a raster drawn, where it does not leave that to the reader: its bands, numbered from one, the
 * values each is drawn between, without which they are drawn as they are, and the ramp one band is coloured through,
 * or BY_CLASS in its place.
 */
export type GeoLook = { bands: number[]; ranges?: [number, number][]; ramp?: string };

/**
 * Asked for where a ramp would be, a band of classes is drawn by them, each in its own colour. The reader knows it as
 * BY_CLASS in geoengine/python/geocodekit/preview/_raster.py.
 */
export const BY_CLASS = 'classes';

/** A page of a layer's table: the row it begins at, and the numbers and the values of its features, a row each. */
const rowsSchema = z.object({ offset: z.number(), fids: z.array(z.number()), rows: z.array(z.array(shownValue)) });

export type GeoRows = z.infer<typeof rowsSchema>;

export type FoundFeature = NonNullable<z.infer<typeof foundSchema>['found']>;

const refusalSchema = z.object({ error: z.string(), code: z.string().optional() });

/** The code a refused request was answered with, for a request the map made itself. */
export const refusalCode = async (response: Response): Promise<string> =>
  refusalSchema.safeParse(await response.json().catch(() => null)).data?.code ?? 'failed';

/** A refusal carries the reader's code for it, which the preview words; it is never read as an empty answer. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

/** A dataset, or one layer of it, as the routes are told which. */
export type Target = { path: string; layer?: string };

const targetQuery = (target: Target): string => {
  const query = new URLSearchParams({ path: target.path });
  if (target.layer !== undefined) query.set('layer', target.layer);
  return query.toString();
};

const request = async <T>(address: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<Outcome<T>> => {
  const response = await runtimeFetch(address, { signal }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in response) return { ok: false, code: 'unavailable', reason: response.error };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    return { ok: false, code: refusal.data?.code ?? 'failed', reason: refusal.data?.error ?? `The request failed (${response.status})` };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'failed', reason: 'The answer was in a form this interface cannot read' };
};

export const describeGeoData = (target: Target, signal?: AbortSignal): Promise<Outcome<GeoDescription>> =>
  request(`${PREVIEW_PATH}/describe?${targetQuery(target)}`, descriptionSchema, signal);

/** The feature at a place in the map's plane, within `tolerance` metres of it, among the `forms` that are shown. */
export const identifyGeoFeature = (target: Target, stamp: string, at: { x: number; y: number; tolerance: number }, forms: readonly Form[]): Promise<Outcome<FoundFeature | null>> =>
  request(`${PREVIEW_PATH}/identify?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}&x=${at.x}&y=${at.y}&tolerance=${at.tolerance}&forms=${forms.join(',')}`, foundSchema)
    .then((outcome) => (outcome.ok ? { ok: true, value: outcome.value.found } : outcome));

/** The feature of a number, as a click finds one. */
export const findGeoFeature = (target: Target, stamp: string, fid: number): Promise<Outcome<FoundFeature | null>> =>
  request(`${PREVIEW_PATH}/identify?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}&fid=${fid}`, foundSchema)
    .then((outcome) => (outcome.ok ? { ok: true, value: outcome.value.found } : outcome));

/** The page of the layer's table that holds `row`. */
export const readGeoRows = (target: Target, stamp: string, row: number, signal?: AbortSignal): Promise<Outcome<GeoRows>> =>
  request(`${PREVIEW_PATH}/rows?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}&row=${row}`, rowsSchema, signal);

/** What a raster's bands measure, and what it may be drawn with. */
export const readGeoStatistics = (target: Target, stamp: string, signal?: AbortSignal): Promise<Outcome<GeoStatistics>> =>
  request(`${PREVIEW_PATH}/statistics?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}`, statisticsSchema, signal)
    .then((outcome) => (outcome.ok ? { ok: true, value: outcome.value.statistics } : outcome));

/**
 * The address of the tiles of the data under `stamp`, with the tile's own numbers left for the map to fill in. With
 * `fid`, the tiles are of that one feature alone; with `look`, a raster's are drawn as it says. Both come last: tiles
 * are told apart by how their addresses begin.
 */
export const tileAddress = (target: Target, stamp: string, asked: { fid?: number; look?: GeoLook | null } = {}): string => {
  const fid = asked.fid === undefined ? '' : `&fid=${asked.fid}`;
  const look = asked.look ? `&look=${encodeURIComponent(JSON.stringify(asked.look))}` : '';
  return `${TILE_SCHEME}://tile?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}&z={z}&x={x}&y={y}${fid}${look}`;
};

/** What a tile's address is asked of the shell server as. */
export const tileRequestPath = (address: string): string => `${PREVIEW_PATH}/${address.slice(`${TILE_SCHEME}://`.length)}`;
