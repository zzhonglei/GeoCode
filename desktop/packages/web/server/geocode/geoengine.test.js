import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { GEO_STATUS_EVENT, registerGeoEngine } from './geoengine.js';

describe('GeoCode: GeoEngine for the interface', () => {
  const statuses = { qgis: { status: 'checking', path: '/Applications/QGIS.app' } };
  const listeners = new Set();
  const sent = [];
  const requests = [];
  let signInWaits = false;
  let signInCancelled = false;
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    registerGeoEngine(app, {
      geoEngine: {
        statuses: () => ({ ...statuses }),
        onStatus: (listener) => listeners.add(listener),
        request: async (method, params, options) => {
          requests.push([method, params]);
          if (params?.path === 'relative') return { ok: false, error: { code: 'invalid-params', message: 'relative is not an absolute path' } };
          if (method === 'gee.signIn') {
            options.onProgress({ url: 'https://accounts.google.com/o/oauth2/auth' });
            if (!signInWaits) return { ok: true, result: {} };
            await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
            signInCancelled = true;
            return { ok: false, error: { code: 'cancelled', message: 'the sign-in was cancelled' } };
          }
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

    statuses.qgis = { status: 'unconfigured' };
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

  // Guards against the page's write of one setting sending the other along, which GeoEngine would read as the first.
  it('passes on the Earth Engine settings, one setting at a time', async () => {
    requests.length = 0;
    const put = (body) => fetch(`${base}/api/geocode/gee`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ python: '/opt/python' })).status).toBe(200);
    expect((await put({ project: 'majestic' })).status).toBe(200);
    expect((await put({ python: '/opt/python', project: 'ignored' })).status).toBe(200);
    expect((await put({ environment: '/work/project' })).status).toBe(200);
    expect((await fetch(`${base}/api/geocode/gee/pythons`)).status).toBe(200);
    expect((await fetch(`${base}/api/geocode/gee/recheck`, { method: 'POST' })).status).toBe(200);
    expect(requests).toEqual([
      ['gee.configure', { python: '/opt/python' }],
      ['gee.configure', { project: 'majestic' }],
      ['gee.configure', { python: '/opt/python' }],
      ['gee.configure', { environment: '/work/project' }],
      ['gee.discover', undefined],
      ['gee.recheck', undefined],
    ]);
  });

  const lines = (text) => text.trim().split('\n').map((line) => JSON.parse(line));

  it('streams a sign-in: the address to open, then how it ended', async () => {
    const answer = await fetch(`${base}/api/geocode/gee/sign-in`, { method: 'POST' });
    expect(lines(await answer.text())).toEqual([
      { type: 'progress', data: { url: 'https://accounts.google.com/o/oauth2/auth' } },
      { type: 'result', ok: true, result: {} },
    ]);
  });

  // Guards against a sign-in the user cancelled keeping its Python waiting for the browser.
  it('cancels a sign-in when the page stops waiting for it', async () => {
    signInWaits = true;
    const controller = new AbortController();
    const answer = await fetch(`${base}/api/geocode/gee/sign-in`, { method: 'POST', signal: controller.signal });
    const reader = answer.body.getReader();
    await reader.read();
    controller.abort();
    await expect.poll(() => signInCancelled).toBe(true);
  });
});
