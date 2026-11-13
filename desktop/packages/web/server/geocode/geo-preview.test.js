import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { registerGeoPreview } from './geo-preview.js';

describe('GeoCode: a preview reads a dataset through GeoEngine', () => {
  const requests = [];
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    registerGeoPreview(app, {
      geoEngine: {
        request: (method, params, { signal }) => {
          requests.push({ method, params, signal });
          // A view into a larger buffer, as a message between processes may deliver it.
          if (params.z === 2) return Promise.resolve({ ok: true, result: { bytes: new Uint8Array([9, 9, 0, 10, 255, 9]).subarray(2, 5) } });
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true, error: { code: 'cancelled', message: 'cancelled' } }));
          });
        },
      },
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/geocode/preview`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Guards the bytes of a tile and the name of its file on their way through: a view sent as its whole buffer, or a
  // path in Chinese read as it was encoded, would draw nothing and say nothing.
  it('asks for the tile the address names and answers with its bytes', async () => {
    const tile = await fetch(`${base}/tile?path=${encodeURIComponent('/数据/roads.gpkg')}&layer=roads&stamp=s&z=2&x=3&y=-1`);
    expect([...new Uint8Array(await tile.arrayBuffer())]).toEqual([0, 10, 255]);
    expect(requests.at(-1)).toMatchObject({ method: 'preview.tile', params: { path: '/数据/roads.gpkg', layer: 'roads', stamp: 's', z: 2, x: 3, y: -1 } });
  });

  // Guards against a map that has moved on still being read for where it was.
  it('cancels the read of a tile the window no longer waits for', async () => {
    const leaving = new AbortController();
    const pending = fetch(`${base}/tile?path=%2Fa.tif&stamp=s&z=9&x=0&y=0`, { signal: leaving.signal }).catch(() => undefined);
    await expect.poll(() => requests.at(-1).params.z).toBe(9);
    expect(requests.at(-1).signal.aborted).toBe(false);
    leaving.abort();
    await pending;
    await expect.poll(() => requests.at(-1).signal.aborted).toBe(true);
  });
});
