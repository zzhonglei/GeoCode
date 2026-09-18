/* --- GeoCode: no relay and no device pairing in the desktop shell (docs/DESKTOP.md §6.1, §7.3). The order
 * inside core-routes.js is read from source, because a refusal registered after the handlers stays green here. --- */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import { createRelayService } from '../lib/relay/service.js';
import { PAIRING_ROUTE_PATHS, refusePairingRoutesUnderElectron } from './remote-access-surface.js';

const originalElectron = process.versions.electron;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const recordingApp = () => {
  const paths = [];
  const record = (routePath) => { paths.push(routePath); };
  return { paths, app: { get: record, post: record, put: record, delete: record, all: record, use: record } };
};

const createRelay = (hasRelayDemand) => createRelayService({
  crypto: globalThis.crypto,
  readSettingsFromDiskMigrated: async () => ({}),
  writeSettingsToDisk: async () => {},
  readSettingsStrict: async () => ({}),
  getLocalPort: () => 0,
  hasRelayDemand,
  hostLock: null,
  allowPassiveHost: false,
  logger: { warn: () => {}, info: () => {}, error: () => {} },
});

describe('relay under Electron', () => {
  it('mounts no routes, asks nothing about demand, and has no server id', async () => {
    process.versions.electron = '0.0.0-test';
    const demand = vi.fn(async () => true);
    const relay = createRelay(demand);
    const { app, paths } = recordingApp();
    relay.registerRoutes(app);
    await relay.reconcile();
    expect(paths).toEqual([]);
    expect(demand).not.toHaveBeenCalled();
    expect(await relay.getServerId()).toBeNull();
    expect(await relay.getPairingCandidate()).toBeNull();
    expect((await relay.getStatus()).state).toBe('disabled');
  });

  it('control: outside Electron the same factory mounts the relay routes', () => {
    delete process.versions.electron;
    const relay = createRelay(async () => false);
    const { app, paths } = recordingApp();
    relay.registerRoutes(app);
    expect(paths.filter((p) => p.startsWith('/api/openchamber/relay/')).length).toBeGreaterThanOrEqual(3);
  });
});

const pairingApp = () => {
  const app = express();
  refusePairingRoutesUnderElectron(app);
  app.all([...PAIRING_ROUTE_PATHS], (_req, res) => res.json({ upstream: true }));
  return app;
};

const concrete = (routePath) => routePath.replace(':id', 'session-1');

describe('device pairing under Electron', () => {
  it('answers 404 on every pairing route before the upstream handler', async () => {
    process.versions.electron = '0.0.0-test';
    const app = pairingApp();
    for (const routePath of PAIRING_ROUTE_PATHS) {
      const response = await request(app).get(concrete(routePath));
      expect(response.status, routePath).toBe(404);
    }
    await request(app).post('/api/client-auth/pairing/sessions').expect(404);
  });

  it('control: outside Electron the upstream handler answers', async () => {
    delete process.versions.electron;
    const app = pairingApp();
    for (const routePath of PAIRING_ROUTE_PATHS) {
      const response = await request(app).get(concrete(routePath));
      expect(response.body, routePath).toEqual({ upstream: true });
    }
  });

  it('core-routes.js mounts the refusal ahead of the pairing handlers', () => {
    const source = fs.readFileSync(path.join(serverRoot, 'lib/opencode/core-routes.js'), 'utf8');
    const refusal = source.indexOf('refusePairingRoutesUnderElectron(app);');
    const firstPairingRoute = source.indexOf("app.post('/api/client-auth/pairing/sessions'");
    expect(refusal).toBeGreaterThan(-1);
    expect(firstPairingRoute).toBeGreaterThan(refusal);
    // The refused set has to be the set upstream mounts, or a route slips through.
    for (const routePath of PAIRING_ROUTE_PATHS) {
      expect(source, routePath).toContain(`'${routePath}'`);
    }
  });
});
