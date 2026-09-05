/* --- GeoCode: choosing or upgrading a system OpenCode is not a product surface
 * (docs/DESKTOP.md §7.3).
 *
 * Two runtime facts are pinned. The routes that would find or upgrade a system OpenCode
 * answer 404 under Electron, and a leftover opencodeBinary setting no longer reaches
 * OPENCODE_BINARY or the main process PATH. Each has a control run without the Electron mark
 * that must reach the upstream behaviour, or the guard proves nothing about the path it
 * closes. Harnesses mirror lib/opencode/routes-upgrade.test.js and env-runtime.test.js. --- */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from '../lib/opencode/routes.js';
import { createOpenCodeEnvRuntime } from '../lib/opencode/env-runtime.js';

const originalElectron = process.versions.electron;
const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
  if (originalOpencodeBinary === undefined) delete process.env.OPENCODE_BINARY;
  else process.env.OPENCODE_BINARY = originalOpencodeBinary;
  process.env.PATH = originalPath;
});

const createApp = () => {
  const app = express();
  app.use(express.json());
  const getOpenCodeResolutionSnapshot = vi.fn(async () => ({ resolved: null }));
  registerOpenCodeRoutes(app, {
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability: () => ({ supported: false, manager: 'external', reason: 'external' }),
    readSettingsFromDiskMigrated: async () => ({}),
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
  });
  return { app, getOpenCodeResolutionSnapshot };
};

const createEnvRuntime = (settings) => {
  const state = {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };
  const runtime = createOpenCodeEnvRuntime({
    state,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
  });
  return { runtime, state };
};

describe('system OpenCode routes', () => {
  it('answer 404 under Electron without touching the resolver', async () => {
    process.versions.electron = '0.0.0-test';
    const { app, getOpenCodeResolutionSnapshot } = createApp();
    await request(app).get('/api/config/opencode-resolution').expect(404);
    await request(app).post('/api/opencode/upgrade').send({}).expect(404);
    expect(getOpenCodeResolutionSnapshot).not.toHaveBeenCalled();
  });

  it('keep the version-reading status route, which is what About shows', async () => {
    process.versions.electron = '0.0.0-test';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ healthy: true, version: '1.0.0' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { app } = createApp();
    const response = await request(app).get('/api/opencode/upgrade-status').expect(200);
    expect(response.body.currentVersion).toBe('1.0.0');
  });

  it('control: the same routes outside Electron reach the upstream handlers', async () => {
    delete process.versions.electron;
    const { app, getOpenCodeResolutionSnapshot } = createApp();
    await request(app).get('/api/config/opencode-resolution').expect(200);
    expect(getOpenCodeResolutionSnapshot).toHaveBeenCalledTimes(1);
    await request(app).post('/api/opencode/upgrade').send({}).expect(409);
  });
});

describe('a leftover opencodeBinary setting', () => {
  it('is ignored under Electron: nothing reaches OPENCODE_BINARY or PATH', async () => {
    process.versions.electron = '0.0.0-test';
    delete process.env.OPENCODE_BINARY;
    const { runtime, state } = createEnvRuntime({ opencodeBinary: process.execPath });
    await expect(runtime.applyOpencodeBinaryFromSettings()).resolves.toBeNull();
    expect(process.env.OPENCODE_BINARY).toBeUndefined();
    expect(process.env.PATH).toBe(originalPath);
    expect(state.resolvedOpencodeBinary).toBeNull();
  });

  it('control: outside Electron the same setting is applied', async () => {
    delete process.versions.electron;
    delete process.env.OPENCODE_BINARY;
    const { runtime, state } = createEnvRuntime({ opencodeBinary: process.execPath });
    await expect(runtime.applyOpencodeBinaryFromSettings()).resolves.toBe(process.execPath);
    expect(process.env.OPENCODE_BINARY).toBe(process.execPath);
    expect(state.resolvedOpencodeBinary).toBe(process.execPath);
  });
});
