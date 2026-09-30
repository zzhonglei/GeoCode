import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { loopbackHostOnly } from './loopback-host.js';

// Guards against a DNS-rebinding page, which sends its own host name, reading the unauthenticated routes.
describe('GeoCode: loopbackHostOnly', () => {
  let server;
  let port;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(loopbackHostOnly);
    app.get('/health', (_req, res) => res.status(200).send('upstream'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const statusOf = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

  it('refuses foreign host names, including ones that start like a loopback name, and ignores X-Forwarded-Host', async () => {
    for (const host of [`evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
      expect(await statusOf({ Host: host })).toBe(403);
    }
    expect(await statusOf({ Host: `evil.example:${port}`, 'X-Forwarded-Host': `127.0.0.1:${port}` })).toBe(403);
  });

  it('serves the loopback names the app uses', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      expect(await statusOf({ Host: host })).toBe(200);
    }
  });
});
