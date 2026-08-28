import { describe, expect, it } from 'bun:test';

import {
  applyKernelConnectionToShellEnvironment,
  buildKernelBaseUrl,
  createKernelProcessEnvironment,
} from './kernel-environment.mjs';

describe('createKernelProcessEnvironment', () => {
  it('strips inherited OPENCODE_* so a user-installed opencode cannot steer our kernel', () => {
    const next = createKernelProcessEnvironment({
      environment: { PATH: '/usr/bin', OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_PORT: '4096' },
      platform: 'darwin',
    });
    expect(next.PATH).toBe('/usr/bin');
    expect(next).not.toHaveProperty('OPENCODE_CONFIG');
    expect(next).not.toHaveProperty('OPENCODE_PORT');
  });

  it('maps GEOCODE_X to the OPENCODE_X the kernel reads', () => {
    const next = createKernelProcessEnvironment({
      environment: { GEOCODE_CONFIG: '/etc/geocode.json' },
      platform: 'darwin',
    });
    expect(next.OPENCODE_CONFIG).toBe('/etc/geocode.json');
    expect(next.GEOCODE_CONFIG).toBe('/etc/geocode.json');
  });

  it('translates after stripping, so a GEOCODE_ value wins over an inherited OPENCODE_ one', () => {
    const next = createKernelProcessEnvironment({
      environment: { OPENCODE_CONFIG: '/inherited.json', GEOCODE_CONFIG: '/ours.json' },
      platform: 'darwin',
    });
    expect(next.OPENCODE_CONFIG).toBe('/ours.json');
  });

  it('drops DEBUG everywhere and LD_PRELOAD only on linux', () => {
    const onLinux = createKernelProcessEnvironment({
      environment: { DEBUG: '*', LD_PRELOAD: '/opt/hook.so' },
      platform: 'linux',
    });
    expect(onLinux).not.toHaveProperty('DEBUG');
    expect(onLinux).not.toHaveProperty('LD_PRELOAD');

    const onMac = createKernelProcessEnvironment({
      environment: { DEBUG: '*', LD_PRELOAD: '/opt/hook.so' },
      platform: 'darwin',
    });
    expect(onMac).not.toHaveProperty('DEBUG');
    expect(onMac.LD_PRELOAD).toBe('/opt/hook.so');
  });

  it('skips undefined values and stringifies the rest', () => {
    const next = createKernelProcessEnvironment({
      environment: { KEEP: 'yes', GONE: undefined, NUMERIC: 8080 },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('GONE');
    expect(next.NUMERIC).toBe('8080');
  });

  it('applies overrides last, and an undefined override removes the key', () => {
    const next = createKernelProcessEnvironment({
      environment: { GEOCODE_CONFIG: '/ours.json', XDG_STATE_HOME: '/home/user/.local/state' },
      platform: 'darwin',
      overrides: { XDG_STATE_HOME: '/app/state', OPENCODE_CONFIG: undefined },
    });
    expect(next.XDG_STATE_HOME).toBe('/app/state');
    expect(next).not.toHaveProperty('OPENCODE_CONFIG');
  });

  it('never carries a password, which travels over IPC instead', () => {
    const next = createKernelProcessEnvironment({
      environment: { OPENCODE_SERVER_PASSWORD: 'inherited-secret' },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
  });
});

describe('buildKernelBaseUrl', () => {
  it('builds a URL env-config.js accepts', () => {
    expect(buildKernelBaseUrl({ hostname: '127.0.0.1', port: 51234 })).toBe('http://127.0.0.1:51234');
  });

  it('brackets a bare IPv6 literal, which new URL would otherwise reject', () => {
    expect(buildKernelBaseUrl({ hostname: '::1', port: 51234 })).toBe('http://[::1]:51234');
    expect(buildKernelBaseUrl({ hostname: '[::1]', port: 51234 })).toBe('http://[::1]:51234');
  });

  it('produces a URL with an explicit port and no path, as env-config.js requires', () => {
    const url = new URL(buildKernelBaseUrl({ hostname: '127.0.0.1', port: 4096 }));
    expect(url.protocol).toBe('http:');
    expect(Number.parseInt(url.port, 10)).toBe(4096);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
  });
});

describe('applyKernelConnectionToShellEnvironment', () => {
  it('sets the three variables the shell runtime already reads', () => {
    const environment = {};
    applyKernelConnectionToShellEnvironment({
      environment,
      connection: { baseUrl: 'http://127.0.0.1:51234', password: 'secret' },
    });
    expect(environment.OPENCHAMBER_SKIP_OPENCODE_START).toBe('true');
    expect(environment.OPENCODE_HOST).toBe('http://127.0.0.1:51234');
    expect(environment.OPENCODE_SERVER_PASSWORD).toBe('secret');
  });

  it('clears a stale inherited password when the kernel runs unsecured', () => {
    const environment = { OPENCODE_SERVER_PASSWORD: 'stale' };
    applyKernelConnectionToShellEnvironment({
      environment,
      connection: { baseUrl: 'http://127.0.0.1:51234' },
    });
    expect(environment).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
  });

  it('refuses a connection with no base URL rather than pointing the shell at nothing', () => {
    expect(() => applyKernelConnectionToShellEnvironment({ environment: {}, connection: {} })).toThrow(/base URL/);
    expect(() => applyKernelConnectionToShellEnvironment({ environment: {}, connection: null })).toThrow(/base URL/);
  });
});
