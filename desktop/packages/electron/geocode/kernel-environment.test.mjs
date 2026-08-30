import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyKernelConnectionToShellEnvironment,
  buildKernelBaseUrl,
  createKernelProcessEnvironment,
  INHERITED_PREFIXES,
  stripInheritedForeignVariables,
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

  it('drops the telemetry variables too, which carry neither the OPENCODE_ prefix nor a value we set', () => {
    const next = createKernelProcessEnvironment({
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret',
      },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(next).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
  });

  it('does not translate a GEOCODE_ name into the OPENCODE_ one the kernel reads', () => {
    const next = createKernelProcessEnvironment({
      environment: { GEOCODE_CONFIG: '/ours.json' },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('OPENCODE_CONFIG');
    // `GEOCODE_PY` and friends are our geographic tools' own, not kernel configuration.
    expect(next.GEOCODE_CONFIG).toBe('/ours.json');
  });

  it('covers every prefix the kernel actually reads configuration under', () => {
    // Catches an upstream flag arriving under a prefix this list does not know, inherited in silence.
    const kernel = new URL('../../../../kernel/packages/', import.meta.url).pathname;
    const sources = [
      fs.readFileSync(path.join(kernel, 'core/src/flag/flag.ts'), 'utf8'),
      fs.readFileSync(path.join(kernel, 'opencode/src/effect/runtime-flags.ts'), 'utf8'),
    ].join('\n');
    const names = new Set([...sources.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)].map((match) => match[1]));
    // Names that are not environment variables at all: service identifiers and the like.
    const notEnvironment = new Set(['GET', 'POST', 'HEAD']);
    const uncovered = [...names].filter((name) =>
      !notEnvironment.has(name) && !INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  it('closes the shell process too, ahead of anything that reads or sets those names', () => {
    // Two orderings: shell modules resolve at import, and the kernel connection is written into
    // this same environment, so a late strip would take `OPENCODE_HOST` with it.
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const strippedAt = main.indexOf('stripInheritedForeignVariables(process.env)');
    const kernelStartAt = main.indexOf('startEmbeddedKernel({');
    const shellImportAt = main.indexOf("import('@openchamber/web/server/index.js')");
    expect(strippedAt).toBeGreaterThan(-1);
    expect(kernelStartAt).toBeGreaterThan(strippedAt);
    expect(shellImportAt).toBeGreaterThan(strippedAt);
  });

  it('leaves everything that is not another product alone', () => {
    const environment = { PATH: '/usr/bin', GEOCODE_PY: '/usr/bin/python3', OPENCODE_CONFIG_DIR: '/theirs' };
    const removed = stripInheritedForeignVariables(environment);
    expect(removed).toEqual(['OPENCODE_CONFIG_DIR']);
    expect(environment).toEqual({ PATH: '/usr/bin', GEOCODE_PY: '/usr/bin/python3' });
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
