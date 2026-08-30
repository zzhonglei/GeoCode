import { describe, expect, it } from 'bun:test';

import { startEmbeddedKernel } from './kernel-boot.mjs';

const bootWith = (overrides = {}) => {
  const environment = { PATH: '/usr/bin', OPENCODE_CONFIG: '/inherited.json', ...overrides.environment };
  const calls = [];
  const started = startEmbeddedKernel({
    isDev: false,
    resourcesPath: '/app/Resources',
    fork: () => ({}),
    exists: () => true,
    cwd: '/home/user',
    environment,
    logger: { info: () => {}, warn: () => {} },
    startKernel: async (options) => {
      calls.push(options);
      return {
        connection: { hostname: '127.0.0.1', port: 51234, baseUrl: 'http://127.0.0.1:51234', password: 'secret' },
      };
    },
    ...overrides,
  });
  return { started, environment, calls };
};

describe('startEmbeddedKernel', () => {
  it('starts the staged sidecar and points the shell at what it bound', async () => {
    const { started, environment, calls } = bootWith();
    await started;

    expect(calls[0].sidecarPath).toBe('/app/Resources/kernel/kernel-sidecar.mjs');
    expect(environment.OPENCHAMBER_SKIP_OPENCODE_START).toBe('true');
    expect(environment.OPENCODE_HOST).toBe('http://127.0.0.1:51234');
    expect(environment.OPENCODE_SERVER_PASSWORD).toBe('secret');
  });

  it('hands the kernel an environment with no inherited configuration in it', async () => {
    const { started, calls } = bootWith({
      environment: { PATH: '/usr/bin', OPENCODE_CONFIG: '/inherited.json', GEOCODE_CONFIG: '/ours.json' },
    });
    await started;

    expect(calls[0].environment).not.toHaveProperty('OPENCODE_CONFIG');
    expect(calls[0].environment.GEOCODE_CONFIG).toBe('/ours.json');
    expect(calls[0].environment.PATH).toBe('/usr/bin');
  });

  it('refuses to start when the runtime was never staged, naming the fix', async () => {
    await expect(bootWith({ exists: () => false }).started).rejects.toThrow(/prepare:geocode-kernel/);
  });

  it('resolves the development path from the module directory instead', async () => {
    await expect(bootWith({
      isDev: true,
      moduleDirectory: '/repo/packages/electron',
      exists: () => false,
    }).started).rejects.toThrow(/\/repo\/packages\/electron\/resources\/kernel\/kernel-sidecar\.mjs/);
  });

  it('leaves the shell environment untouched when the kernel never starts', async () => {
    const { started, environment } = bootWith({
      startKernel: async () => { throw new Error('kernel refused to start'); },
    });
    await expect(started).rejects.toThrow(/refused to start/);
    expect(environment).not.toHaveProperty('OPENCHAMBER_SKIP_OPENCODE_START');
    expect(environment).not.toHaveProperty('OPENCODE_HOST');
  });
});
