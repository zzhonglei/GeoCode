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

  it('strips again inside the login-shell merge, which refills whatever module load removed', () => {
    // The merge fills every key that is undefined, and a stripped key is exactly that. So the
    // strip has to sit in the same function body, after the loop, where no later call can land
    // between them (docs/ENVIRONMENT.md §5.2 invariant 1).
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const functionStart = main.indexOf('const inheritUserShellEnv = () => {');
    const functionEnd = main.indexOf('\n};', functionStart);
    const mergeLoop = main.indexOf('for (const [key, value] of Object.entries(shellEnv))', functionStart);
    const stripInside = main.indexOf('stripInheritedForeignVariables(process.env)', mergeLoop);
    expect(functionStart).toBeGreaterThan(-1);
    expect(mergeLoop).toBeGreaterThan(functionStart);
    expect(mergeLoop).toBeLessThan(functionEnd);
    expect(stripInside).toBeGreaterThan(mergeLoop);
    expect(stripInside).toBeLessThan(functionEnd);
  });

  it('never merges the login shell again once the kernel connection has been written', () => {
    // Invariant 2: the strip now rides inside the merge, so a merge placed after
    // startEmbeddedKernel would take OPENCODE_HOST and the password with it.
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const kernelStartAt = main.indexOf('startEmbeddedKernel({');
    const calls = [...main.matchAll(/inheritUserShellEnv\(\);/g)].map((match) => match.index);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) expect(at).toBeLessThan(kernelStartAt);
  });

  it('keeps the UI password out of the child until OPENCHAMBER_ joins the prefix table', () => {
    const main = fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const kernelStartAt = main.indexOf('startEmbeddedKernel({');
    const callEnd = main.indexOf('});', kernelStartAt);
    expect(main.slice(kernelStartAt, callEnd)).toContain('OPENCHAMBER_UI_PASSWORD: undefined');
  });

  it('lets the shell runtime skip its own login-shell merge under Electron', () => {
    // Invariant 3: one merge per process. The shell keeps its merge for standalone serve; the
    // Electron build passes the upstream line by, byte-identical inside a comment.
    const lines = fs
      .readFileSync(new URL('../../web/server/index.js', import.meta.url).pathname, 'utf8')
      .split('\n');
    const shielded = lines.findIndex((line) => line.includes('/* applyLoginShellEnvSnapshot(); */'));
    expect(shielded).toBeGreaterThan(0);
    expect(lines[shielded - 1]).toContain('process.versions.electron');
    expect(lines[shielded - 1]).toContain('applyLoginShellEnvSnapshot();');
    const live = lines.filter((line) => /^\s*(if \(.+\) )?applyLoginShellEnvSnapshot\(\);\s*$/.test(line));
    expect(live).toHaveLength(1);
  });

  it('leaves everything that is not another product alone', () => {
    const environment = { PATH: '/usr/bin', GEOCODE_PY: '/usr/bin/python3', OPENCODE_CONFIG_DIR: '/theirs' };
    const removed = stripInheritedForeignVariables(environment);
    expect(removed).toEqual(['OPENCODE_CONFIG_DIR']);
    expect(environment).toEqual({ PATH: '/usr/bin', GEOCODE_PY: '/usr/bin/python3' });
  });

  it('keeps the names the caller asks for, which is how launcher knobs survive the strip', () => {
    const environment = { OPENCODE_KEEP_ME: '1', OPENCODE_GONE: '2' };
    const removed = stripInheritedForeignVariables(environment, { keep: ['OPENCODE_KEEP_ME'] });
    expect(removed).toEqual(['OPENCODE_GONE']);
    expect(environment).toEqual({ OPENCODE_KEEP_ME: '1' });
  });

  it('drops the runtime switches that change what code the child runs, per platform', () => {
    // Every one of these was measured in a real utility process (docs/ENVIRONMENT.md §3 no. 4):
    // NODE_OPTIONS --require executes a file, DYLD_INSERT_LIBRARIES loads a dylib,
    // ELECTRON_RUN_AS_NODE keeps the child from starting, NODE_V8_COVERAGE writes to disk.
    const poisoned = {
      NODE_OPTIONS: '--require /tmp/x.js',
      NODE_PATH: '/tmp/modules',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_V8_COVERAGE: '/tmp/coverage',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      LD_PRELOAD: '/tmp/x.so',
      // The user's toolchain, which the kernel's own children inherit and rely on.
      LD_LIBRARY_PATH: '/opt/gdal/lib',
      DYLD_LIBRARY_PATH: '/opt/gdal/lib',
      NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      XDG_CONFIG_HOME: '/home/user/.config',
      ANTHROPIC_API_KEY: 'sk-user',
      GITHUB_TOKEN: 'ghp-user',
    };
    const onMac = createKernelProcessEnvironment({ environment: poisoned, platform: 'darwin' });
    const onLinux = createKernelProcessEnvironment({ environment: poisoned, platform: 'linux' });
    for (const gone of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'NODE_V8_COVERAGE']) {
      expect(onMac).not.toHaveProperty(gone);
      expect(onLinux).not.toHaveProperty(gone);
    }
    expect(onMac).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(onMac.LD_PRELOAD).toBe('/tmp/x.so');
    expect(onLinux).not.toHaveProperty('LD_PRELOAD');
    expect(onLinux.DYLD_INSERT_LIBRARIES).toBe('/tmp/x.dylib');
    for (const kept of ['LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'XDG_CONFIG_HOME', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
      expect(onMac[kept]).toBe(poisoned[kept]);
      expect(onLinux[kept]).toBe(poisoned[kept]);
    }
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
