/* --- GeoCode: the shell registers no tunnel routes under Electron (docs/DESKTOP.md §6.1, §7.3).
 *
 * The routes runtime is built with inert dependencies and given a recording stand-in for the
 * Express app, because what is asserted is registration, not behaviour: under Electron nothing
 * is mounted at all, so a route upstream adds later is covered too. The control run without
 * the Electron mark must mount the whole surface, or the guard proves nothing. --- */
import { afterEach, describe, expect, it } from 'vitest';
import { createTunnelRoutesRuntime } from '../lib/tunnels/routes.js';

const originalElectron = process.versions.electron;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const inert = () => null;

const createRuntime = () => createTunnelRoutesRuntime({
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
});

const mountedPaths = () => {
  const paths = [];
  const record = (path) => { paths.push(path); };
  createRuntime().registerRoutes({ get: record, post: record, put: record, delete: record, all: record, use: record });
  return paths;
};

describe('tunnel surface', () => {
  it('mounts nothing under Electron', () => {
    process.versions.electron = '0.0.0-test';
    expect(mountedPaths()).toEqual([]);
  });

  it('control: outside Electron the whole tunnel surface is mounted', () => {
    delete process.versions.electron;
    const paths = mountedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(paths.every((path) => path.startsWith('/api/openchamber/tunnel/'))).toBe(true);
    expect(paths).toContain('/api/openchamber/tunnel/start');
  });
});
