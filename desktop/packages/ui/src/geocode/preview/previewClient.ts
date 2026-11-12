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
export type GeoBounds = NonNullable<GeoDescription['bounds']>;

/** An attribute's value as it is shown: text as it is, anything else as JSON writes it; no value stays none, told from empty text. */
const shownValue = z.union([z.string(), z.null(), z.unknown().transform((value) => JSON.stringify(value))]);

const foundSchema = z.object({
  found: z.object({ fid: z.number(), attributes: z.array(z.tuple([z.string(), shownValue])) }).nullable(),
});

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

/** The address of the tiles of the data under `stamp`, with the tile's own numbers left for the map to fill in. */
export const tileAddress = (target: Target, stamp: string): string =>
  `${TILE_SCHEME}://tile?${targetQuery(target)}&stamp=${encodeURIComponent(stamp)}&z={z}&x={x}&y={y}`;

/** What a tile's address is asked of the shell server as. */
export const tileRequestPath = (address: string): string => `${PREVIEW_PATH}/${address.slice(`${TILE_SCHEME}://`.length)}`;
