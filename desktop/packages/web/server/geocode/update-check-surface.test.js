/* --- GeoCode: the shell does not ask OpenChamber's update service (docs/DESKTOP.md §7.2).
 *
 * Upstream's route posts the version and a persistent install id to api.openchamber.dev,
 * and the renderer calls it three seconds after start and hourly after that. Under Electron
 * the route answers "no update" locally and the web self-install route is gone. The control
 * run without the Electron mark must reach the network call, or the guard proves nothing. --- */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenChamberRoutes } from '../lib/opencode/openchamber-routes.js';

const originalElectron = process.versions.electron;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerOpenChamberRoutes(app, {
    fs: {},
    path: {},
    process,
    server: null,
    __dirname: '/tmp',
    openchamberDataDir: '/tmp/geocode-update-check-test',
    modelsDevApiUrl: 'https://example.invalid/models',
    modelsMetadataCacheTtl: 1000,
    readSettingsFromDiskMigrated: async () => ({}),
    fetchFreeZenModels: async () => [],
    getCachedZenModels: () => [],
  });
  return app;
};

describe('update check surface', () => {
  it('answers "no update" locally under Electron and drops the self-install route', async () => {
    process.versions.electron = '0.0.0-test';
    globalThis.fetch = vi.fn();
    const app = createApp();
    const response = await request(app).get('/api/openchamber/update-check?appType=desktop-electron').expect(200);
    expect(response.body).toEqual({ available: false });
    await request(app).post('/api/openchamber/update-install').expect(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('control: outside Electron the same route does contact the update service', async () => {
    delete process.versions.electron;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 }));
    const app = createApp();
    await request(app).get('/api/openchamber/update-check?appType=desktop-electron&reportUsage=false');
    const urls = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('openchamber.dev'))).toBe(true);
  });
});
