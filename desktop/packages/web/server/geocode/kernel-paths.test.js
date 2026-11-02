import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards against the shell reading and writing kernel files where the bundled kernel does not keep them.
const VARIABLES = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
const saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));
const KERNEL = '../../../../../kernel/packages';

// Both modules read the environment when they load, so each case loads them afresh.
const load = async (env) => {
  for (const key of VARIABLES) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  const shell = await import('./kernel-paths.js');
  const { Path } = await import('../../../../../kernel/packages/util/src/global.ts');
  return { shell, kernel: Path };
};

afterEach(() => {
  for (const key of VARIABLES) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('GeoCode: kernel paths', () => {
  // A login shell or Settings could otherwise move the kernel's files away from the shell's and GeoEngine's.
  it('match the kernel, under the home directory whatever the XDG variables say', async () => {
    const { shell, kernel } = await load({
      XDG_CONFIG_HOME: '/xdg/config', XDG_DATA_HOME: '/xdg/data', XDG_CACHE_HOME: '/xdg/cache', XDG_STATE_HOME: '/xdg/state',
    });
    expect(shell.kernelConfigDir()).toBe(kernel.config);
    expect(shell.kernelDataDir()).toBe(kernel.data);
    expect(shell.kernelStateDir()).toBe(kernel.state);
    expect(shell.kernelTmpDir()).toBe(kernel.tmp);
    // Apart from an installed OpenCode's: the two agreeing on another name would still share its files.
    expect(kernel.config).toBe(path.join(os.homedir(), '.config', 'geocode'));
    expect(kernel.data).toBe(path.join(os.homedir(), '.local', 'share', 'geocode'));
    expect(kernel.cache).toBe(path.join(os.homedir(), '.cache', 'geocode'));
    expect(kernel.state).toBe(path.join(os.homedir(), '.local', 'state', 'geocode'));
  });

  // The kernel tells agents they may read and write its temporary folder, and an installed OpenCode keeps its own.
  it('keep generated images in the kernel\'s temporary folder', async () => {
    const { kernel } = await load({});
    const { GENERATED_IMAGE_DIRECTORY } = await import('../lib/openchamber-control/generate-image.js');
    expect(GENERATED_IMAGE_DIRECTORY).toBe(path.join(kernel.tmp, 'generated-images'));
    expect(GENERATED_IMAGE_DIRECTORY).toBe(path.join(os.tmpdir(), 'geocode', 'generated-images'));
  });

  it('name the config files, the project directory and the project id file as the kernel does', async () => {
    const shell = await import('./kernel-paths.js');
    const { names } = await import('../../../../../kernel/packages/core/src/config/discovery.ts');
    expect([shell.KERNEL_CONFIG_JSON, shell.KERNEL_CONFIG_JSONC]).toEqual(names);
    // Written inline where the kernel reads them.
    const source = (file) => fs.readFileSync(new URL(`${KERNEL}/core/src/${file}`, import.meta.url), 'utf8');
    expect(source('config/discovery.ts')).toContain(`"${shell.KERNEL_PROJECT_DIR}"`);
    expect(source('project.ts')).toContain(`path.join(dir, "${shell.KERNEL_PROJECT_ID_FILE}")`);
    expect([...names, shell.KERNEL_PROJECT_DIR, shell.KERNEL_PROJECT_ID_FILE]).toEqual([
      'geocode.json', 'geocode.jsonc', '.geocode', 'geocode',
    ]);
  });
});
