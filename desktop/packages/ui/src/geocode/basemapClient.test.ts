import { expect, mock, test } from 'bun:test';

const asked: string[] = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string) => {
    asked.push(path);
    return new Response(new ArrayBuffer(1));
  },
}));

const { readBasemapResource } = await import('./basemapClient');

// Guards what a page in the chat can have the window ask the shell server for through the basemap: its tiles and
// icons alone, never another route reached by an address the page writes itself.
test('GeoCode: a page reads nothing but the basemap through it', async () => {
  const outcomes = await Promise.allSettled([
    readBasemapResource('geocode-basemap://tile/openfreemap.ne2_shaded/6/53/27'),
    readBasemapResource('geocode-basemap://sprite/versatiles.base@2x.json'),
    readBasemapResource('geocode-basemap://../../../../api/fs/read?path=/etc/passwd'),
    readBasemapResource('geocode-basemap://tile/vector/1/0/0/../../../../config/settings'),
    readBasemapResource('geocode-basemap://tile/../0/0/0'),
    readBasemapResource('geocode-basemap://sprite/..%2F..%2Fconfig.json'),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected', 'rejected']);
  expect(asked).toEqual(['/api/geocode/basemap/tile/openfreemap.ne2_shaded/6/53/27', '/api/geocode/basemap/sprite/versatiles.base@2x.json']);
});
