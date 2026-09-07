/* --- GeoCode: the shell registers no plugin-management routes under Electron (KERNEL.md §6 item 1,
 * docs/DESKTOP.md §7.3).
 *
 * The kernel loads no plugin a configuration declares, so everything this surface writes would be
 * discarded; one of its routes also reaches npm, which §7.3 forbids. Asserted by giving the
 * registrar a recording stand-in for the Express app: what matters is registration, not behaviour,
 * so a route upstream adds later is covered too. The control run without the Electron mark must
 * mount the whole surface, or the guard proves nothing. --- */
import { afterEach, describe, expect, it } from 'vitest';
import { registerPluginRoutes } from '../lib/opencode/plugin-routes.js';

const originalElectron = process.versions.electron;

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
});

const inert = () => null;

const mountedPaths = () => {
  const paths = [];
  const record = (path) => { paths.push(path); };
  registerPluginRoutes(
    { get: record, post: record, put: record, patch: record, delete: record, all: record, use: record },
    {
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
    },
  );
  return paths;
};

describe('plugin surface', () => {
  it('mounts nothing under Electron', () => {
    process.versions.electron = '0.0.0-test';
    expect(mountedPaths()).toEqual([]);
  });

  it('control: outside Electron the whole plugin surface is mounted', () => {
    delete process.versions.electron;
    const paths = mountedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(10);
    expect(paths.every((path) => path.startsWith('/api/config/plugins'))).toBe(true);
    // The one that leaves the machine, named so a merge cannot quietly reintroduce it alone.
    expect(paths).toContain('/api/config/plugins/registry');
  });
});
