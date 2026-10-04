import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { GEO_STATUS_EVENT, registerGeoEngine } from './geoengine.js';

describe('GeoCode: GeoEngine for the interface', () => {
  const statuses = { qgis: { status: 'checking', path: '/Applications/QGIS.app' } };
  const listeners = new Set();
  const sent = [];
  const requests = [];
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    registerGeoEngine(app, {
      geoEngine: {
        statuses: () => ({ ...statuses }),
        onStatus: (listener) => listeners.add(listener),
        request: async (method, params) => {
          requests.push([method, params]);
          if (params?.path === 'relative') return { ok: false, error: { code: 'invalid-params', message: 'relative is not an absolute path' } };
          return { ok: true, result: method === 'qgis.discover' ? { installs: [] } : {} };
        },
      },
      broadcast: (payload) => sent.push(payload),
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const snapshot = async () => (await fetch(`${base}/api/geocode/geo-status`)).json();

  // Guards against a snapshot and the changes after it disagreeing on the revision, which lets the interface keep a stale status.
  it('counts every change in both the snapshot and the change it sends', async () => {
    expect(await snapshot()).toEqual({ revision: 0, statuses });

    statuses.qgis = { status: 'unconfigured', hint: 'set it' };
    for (const listener of listeners) listener('qgis', statuses.qgis);

    expect(sent).toEqual([{ type: GEO_STATUS_EVENT, properties: { revision: 1, domain: 'qgis', value: statuses.qgis } }]);
    expect(await snapshot()).toEqual({ revision: 1, statuses });
  });

  // Guards against a refused choice reading as saved.
  it('passes on the settings requests, and their refusals as refusals', async () => {
    const put = (path) => fetch(`${base}/api/geocode/qgis`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    expect((await put('/Applications/QGIS.app')).status).toBe(200);
    const refused = await put('relative');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'relative is not an absolute path', code: 'invalid-params' });
    expect(await (await fetch(`${base}/api/geocode/qgis/installs`)).json()).toEqual({ installs: [] });
    expect((await fetch(`${base}/api/geocode/qgis/recheck`, { method: 'POST' })).status).toBe(200);
    expect(requests.map(([method]) => method)).toEqual(['qgis.configure', 'qgis.configure', 'qgis.discover', 'qgis.recheck']);
  });
});
