import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// Guards against the shell reading and writing kernel files where the bundled kernel does not keep them.
const VARIABLES = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
const saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));

// Both modules read the environment when they load, so each case loads them afresh.
const load = async (env) => {
  for (const key of VARIABLES) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  const shell = await import('./kernel-paths.js');
  const kernel = await import('../../../../../kernel/packages/util/src/global-roots.ts');
  return { shell, kernel: kernel.roots('geocode') };
};

afterEach(() => {
  for (const key of VARIABLES) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('GeoCode: kernel paths', () => {
  it.each([
    ['unset', {}],
    ['set', { XDG_CONFIG_HOME: '/xdg/config', XDG_DATA_HOME: '/xdg/data' }],
    ['empty', { XDG_CONFIG_HOME: '', XDG_DATA_HOME: '' }],
  ])('match the kernel with XDG variables %s', async (_name, env) => {
    const { shell, kernel } = await load(env);
    expect(shell.kernelConfigDir()).toBe(kernel.config);
    expect(shell.kernelDataDir()).toBe(kernel.data);
    expect(shell.kernelTmpDir()).toBe(kernel.tmp);
  });

  it('are GeoCode directories', async () => {
    const { shell } = await load({});
    expect(shell.kernelConfigDir()).toBe(path.join(os.homedir(), '.config', 'geocode'));
    expect(shell.kernelDataDir()).toBe(path.join(os.homedir(), '.local', 'share', 'geocode'));
  });
});
