import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';

import { closedSurface } from './closed-surface.js';

// Guards against a closed endpoint staying reachable through a path variant
// that Express still routes to the upstream handler.
describe('GeoCode: closedSurface', () => {
  let server;
  let baseUrl;
  const hadElectron = Object.prototype.hasOwnProperty.call(process.versions, 'electron');

  beforeAll(async () => {
    process.versions.electron = 'test';
    const app = express();
    app.use(closedSurface);
    for (const route of ['/api/openchamber/update-check', '/api/push/subscribe', '/connect', '/api/client-auth/clients', '/api/push/visibility', '/api/plugin', '/api/plugin/check', '/api/magic-prompts/:id']) {
      app.all(route, (_req, res) => res.status(200).send('upstream'));
    }
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (!hadElectron) delete process.versions.electron;
    await new Promise((resolve) => server.close(resolve));
  });

  const statusOf = async (path) => (await fetch(`${baseUrl}${path}`)).status;

  it('refuses closed endpoints in any case and with a trailing slash', async () => {
    for (const path of ['/api/openchamber/update-check', '/API/OpenChamber/Update-Check', '/api/push/subscribe/', '/CONNECT', '/API/Client-Auth/Clients', '/API/Plugin/Check', '/API/Magic-Prompts/git.commit.generate.visible']) {
      expect(await statusOf(path)).toBe(404);
    }
  });

  it('leaves the endpoints the desktop app still uses to upstream', async () => {
    expect(await statusOf('/api/push/visibility')).toBe(200);
    expect(await statusOf('/api/plugin')).toBe(200);
  });
});
