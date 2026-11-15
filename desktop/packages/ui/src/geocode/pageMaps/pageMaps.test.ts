import { expect, mock, test } from 'bun:test';

import type { PageFrame } from './pageMaps';

const read: string[] = [];

mock.module('../preview/previewClient', () => ({
  readGeoFeatures: async (target: { path: string }) => {
    read.push(target.path);
    return { ok: true, body: new ArrayBuffer(0) };
  },
  readGeoGrid: async (target: { path: string }) => {
    read.push(target.path);
    return { ok: true, grid: { width: 0, height: 0, bands: 1, coordinates: [] }, bytes: new ArrayBuffer(0) };
  },
}));

const { answerGeoPage } = await import('./pageMaps');

/** What a map page asks the chat for, as its kit posts it. */
type Asked = { type: string; id: number; path: string; fields?: string[]; bands?: number[] };

// Guards what a map page in the chat may read: only data whose path stands in full in its own document, so a page
// cannot read a file it builds a path to.
test('GeoCode: a map page reads only the data it names in full', async () => {
  const replies: { id: number; error?: string }[] = [];
  const frame: PageFrame = {
    srcdoc: '<script>geocode.vector("/data/roads.shp"); geocode.raster("C:\\\\data\\\\dem.tif")</script>',
    contentWindow: { postMessage: (message: { id: number; error?: string }) => replies.push(message) },
  };
  const ask = (data: Asked) => answerGeoPage(new MessageEvent('message', { data }), frame);
  ask({ type: 'geocode/vector', id: 1, path: '/data/secret.shp', fields: [] });
  ask({ type: 'geocode/vector', id: 2, path: '/data/roads.shp', fields: [] });
  ask({ type: 'geocode/raster', id: 3, path: 'C:\\data\\dem.tif', bands: [1] });
  await new Promise((settled) => setTimeout(settled, 0));
  expect(read).toEqual(['/data/roads.shp', 'C:\\data\\dem.tif']);
  expect(replies.filter((reply) => reply.error !== undefined).map((reply) => reply.id)).toEqual([1]);
});
