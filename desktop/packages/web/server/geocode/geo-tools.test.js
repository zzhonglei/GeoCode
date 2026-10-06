import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { GEO_TOOL_PATH, registerGeoTools } from './geo-tools.js';

const TOKEN = 'kernel-token';

describe('GeoCode: the geo tools reach GeoEngine', () => {
  const requests = [];
  let release = () => {};
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    registerGeoTools(app, {
      authorize: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
      geoEngine: {
        request: (method, params, { signal, onProgress }) => {
          requests.push({ method, params, signal });
          if (params?.action === 'refuse') return Promise.resolve({ ok: false, error: { code: 'not-ready', message: 'QGIS is not configured.' } });
          onProgress({ percent: 50 });
          if (params?.action !== 'hold') return Promise.resolve({ ok: true, result: { text: 'QGIS 4.2.3' } });
          return new Promise((resolve) => {
            release = () => resolve({ ok: true, result: {} });
            signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true, error: { code: 'cancelled', message: 'cancelled' } }));
          });
        },
      },
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    release();
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (body, token = TOKEN, signal) =>
    fetch(`${base}${GEO_TOOL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  const lines = async (response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

  // Guards against anything on this machine but the kernel reaching GeoEngine.
  it('refuses a caller without the kernel token, and a method no tool calls', async () => {
    expect((await call({ method: 'qgis.doc', params: {} }, 'wrong')).status).toBe(401);
    const unknown = await call({ method: 'qgis.configure', params: { path: '/tmp' } });
    expect(unknown.status).toBe(400);
    expect(requests).toEqual([]);
  });

  // Guards against qgisrun failing at the shell server on any of its three steps.
  it('lets each step of a run through', async () => {
    for (const method of ['qgis.locate', 'qgis.prepare', 'qgis.run']) {
      expect((await call({ method, params: { algorithm: 'native:buffer' } })).status).toBe(200);
    }
    expect(requests.splice(0).map((request) => request.method)).toEqual(['qgis.locate', 'qgis.prepare', 'qgis.run']);
  });

  it('streams the progress and then the result, refusals included', async () => {
    const response = await call({ method: 'qgis.doc', params: { action: 'groups' } });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await lines(response)).toEqual([
      { type: 'progress', data: { percent: 50 } },
      { type: 'result', ok: true, result: { text: 'QGIS 4.2.3' } },
    ]);
    expect(await lines(await call({ method: 'qgis.doc', params: { action: 'refuse' } }))).toEqual([
      { type: 'result', ok: false, error: { code: 'not-ready', message: 'QGIS is not configured.' } },
    ]);
  });

  // Guards against a stopped tool call leaving its task running in GeoEngine.
  it('cancels the task when the tool call goes away', async () => {
    const controller = new AbortController();
    const response = await call({ method: 'qgis.doc', params: { action: 'hold' } }, TOKEN, controller.signal);
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    const held = requests.at(-1);
    await expect.poll(() => held.signal.aborted).toBe(true);
  });
});
