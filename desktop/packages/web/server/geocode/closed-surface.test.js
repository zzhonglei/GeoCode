/* --- GeoCode: the magic prompt, plugin, tunnel, Linear, extension and routing surfaces answer 404 under
 * Electron, and none of their requests, including routes upstream adds later, reaches the kernel proxy
 * (docs/DESKTOP.md §7.3). --- */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerMagicPromptRoutes } from '../lib/magic-prompts/routes.js';
import { registerPluginRoutes } from '../lib/opencode/plugin-routes.js';
import { createTunnelRoutesRuntime } from '../lib/tunnels/routes.js';
import { registerLinearRoutes } from '../lib/linear/routes.js';
import { registerGuestRoutes } from '../lib/guests/routes.js';
import { registerRoutingRoutes } from '../lib/routing/routes.js';
import { isRoutingFeatureAvailable } from '../lib/routing/feature-flag.js';

const originalElectron = process.versions.electron;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const inert = () => null;

const SURFACES = [
  {
    name: 'linear',
    prefix: '/api/linear',
    // The OAuth callback is the one route outside `/api`, so the control below has to accept a second prefix.
    extraPrefix: '/linear',
    minimum: 14,
    named: { method: 'get', path: '/api/linear/auth/status' },
    register: (app) => registerLinearRoutes(app),
  },
  {
    name: 'magic prompt',
    prefix: '/api/magic-prompts',
    minimum: 4,
    named: { method: 'get', path: '/api/magic-prompts' },
    register: (app) => registerMagicPromptRoutes(app, {
      fsPromises: {},
      path: { join: (...parts) => parts.join('/') },
      openchamberDataDir: '/tmp/geocode-closed-surface-test',
    }),
  },
  {
    name: 'plugin',
    prefix: '/api/config/plugins',
    minimum: 10,
    named: { method: 'get', path: '/api/config/plugins/registry' },
    register: (app) => registerPluginRoutes(app, {
      resolveOptionalProjectDirectory: inert,
      listPluginEntries: inert,
      getPluginEntry: inert,
      createPluginEntry: inert,
      updatePluginEntry: inert,
      deletePluginEntry: inert,
      listPluginDirFiles: inert,
      readPluginDirFile: inert,
      writePluginDirFile: inert,
      deletePluginDirFile: inert,
      encodePluginId: inert,
      decodePluginId: inert,
      refreshOpenCodeAfterConfigChange: inert,
      clientReloadDelayMs: 0,
    }),
  },
  {
    name: 'extension',
    prefix: '/api/guests',
    minimum: 20,
    named: { method: 'get', path: '/api/guests' },
    register: (app) => registerGuestRoutes(app, {
      openchamberDataDir: '/tmp/geocode-closed-surface-test',
      openchamberVersion: '0.0.0-test',
      resolveGitBinaryForSpawn: inert,
      resolveOptionalProjectDirectory: inert,
      getSmallModelService: inert,
    }),
  },
  {
    name: 'routing',
    prefix: '/api/routing',
    minimum: 2,
    named: { method: 'get', path: '/api/routing' },
    // The control run needs the capability on, or upstream mounts nothing to compare against.
    beforeControl: () => { process.env.OPENCHAMBER_ROUTING_ENABLE = '1'; },
    afterControl: () => { delete process.env.OPENCHAMBER_ROUTING_ENABLE; },
    register: (app) => registerRoutingRoutes(app, { describe: inert, setToken: inert, clearToken: inert }),
  },
  {
    name: 'tunnel',
    prefix: '/api/openchamber/tunnel',
    minimum: 8,
    named: { method: 'post', path: '/api/openchamber/tunnel/start' },
    register: (app) => createTunnelRoutesRuntime({
      crypto: {},
      URL,
      tunnelService: { resolveActiveMode: inert, getPublicUrl: inert },
      tunnelProviderRegistry: {},
      tunnelAuthController: {},
      readSettingsFromDiskMigrated: async () => ({}),
      readManagedRemoteTunnelConfigFromDisk: async () => ({}),
      normalizeTunnelProvider: inert,
      normalizeTunnelMode: inert,
      normalizeOptionalPath: inert,
      normalizeManagedRemoteTunnelHostname: inert,
      normalizeTunnelBootstrapTtlMs: inert,
      normalizeTunnelSessionTtlMs: inert,
      isSupportedTunnelMode: () => false,
      upsertManagedRemoteTunnelToken: inert,
      resolveManagedRemoteTunnelToken: inert,
      TUNNEL_MODE_QUICK: 'quick',
      TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      TunnelServiceError: Error,
      getActivePort: () => 0,
      getRuntimeManagedRemoteTunnelHostname: inert,
      setRuntimeManagedRemoteTunnelHostname: inert,
      getRuntimeManagedRemoteTunnelToken: inert,
      setRuntimeManagedRemoteTunnelToken: inert,
      getActiveTunnelController: inert,
      setActiveTunnelController: inert,
    }).registerRoutes(app),
  },
];

const recordUpstreamRoutes = (register, surface = {}) => {
  delete process.versions.electron;
  surface.beforeControl?.();
  const routes = [];
  const recorder = (method) => (path) => { routes.push({ method, path }); };
  register({
    get: recorder('get'),
    post: recorder('post'),
    put: recorder('put'),
    patch: recorder('patch'),
    delete: recorder('delete'),
    all: recorder('get'),
    use: recorder('get'),
  });
  surface.afterControl?.();
  return routes;
};

describe.each(SURFACES)('$name surface', (surface) => {
  it('control: outside Electron every route it mounts sits under the refused prefix', () => {
    const routes = recordUpstreamRoutes(surface.register, surface);
    expect(routes.length).toBeGreaterThanOrEqual(surface.minimum);
    const prefixes = [surface.prefix, ...(surface.extraPrefix ? [surface.extraPrefix] : [])];
    const under = (path) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    expect(routes.every(({ path }) => under(path))).toBe(true);
    expect(routes).toContainEqual(surface.named);
  });

  it('under Electron each of those routes answers 404 and none reaches the kernel proxy', async () => {
    const routes = recordUpstreamRoutes(surface.register, surface);
    process.versions.electron = '0.0.0-test';
    const forwarded = [];
    const app = express();
    surface.register(app);
    app.use('/api', (req, res) => {
      forwarded.push(`${req.method} ${req.originalUrl}`);
      res.json({ proxied: true });
    });
    for (const { method, path } of routes) {
      await request(app)[method](path.replace(/:[^/]+/g, 'probe')).expect(404);
    }
    await request(app).get(`${surface.prefix}/added-later`).expect(404);
    expect(forwarded).toEqual([]);
  });
});

describe('the routing capability', () => {
  // The prefix refusal above is the second line. This is the first: with the capability off, upstream's own
  // comment says there is no Auto row, no settings page, no routes and no request rewriting.
  it('stays off under Electron even when the environment asks for it', () => {
    process.env.OPENCHAMBER_ROUTING_ENABLE = '1';
    try {
      delete process.versions.electron;
      expect(isRoutingFeatureAvailable()).toBe(true);
      process.versions.electron = '0.0.0-test';
      expect(isRoutingFeatureAvailable()).toBe(false);
    } finally {
      delete process.env.OPENCHAMBER_ROUTING_ENABLE;
    }
  });
});
