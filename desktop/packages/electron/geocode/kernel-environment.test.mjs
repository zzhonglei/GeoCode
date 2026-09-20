import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyKernelConnectionToShellEnvironment,
  buildKernelBaseUrl,
  createKernelProcessEnvironment,
  E2E_ALLOWLIST,
  INHERITED_PREFIXES,
  INJECTED_ONLY,
  LAUNCHER_ALLOWLIST,
  stripInheritedForeignVariables,
} from './kernel-environment.mjs';
import { BROWSER_PLUGIN_ENV } from './browser-tool.mjs';

const readMain = () => fs.readFileSync(new URL('../main.mjs', import.meta.url).pathname, 'utf8');

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
    const notEnvironment = new Set(['GET', 'POST', 'HEAD']);
    const uncovered = [...names].filter((name) =>
      !notEnvironment.has(name) && !INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  it('strips the shell process at its very first import, ahead of every other module', () => {
    // Anything evaluated before the strip reads the inherited environment (docs/ENVIRONMENT.md §5.2).
    const main = readMain();
    const firstImport = main.match(/^import .*$/m)[0];
    expect(firstImport).toContain("'./geocode/environment-boundary.mjs'");
    const boundaryAt = main.indexOf(firstImport);
    expect(boundaryAt).toBeLessThan(main.indexOf("from '@openchamber/web/server/lib/fs/routes.js'"));
    expect(boundaryAt).toBeLessThan(main.indexOf('const isDev = '));
    expect(boundaryAt).toBeLessThan(main.indexOf('applyShellDataRoot({'));
  });

  it('strips again inside the login-shell merge and writes the data root straight back', () => {
    // The merge refills every stripped name, and the data root shares the stripped prefix (docs/ENVIRONMENT.md §5.2).
    const main = readMain();
    const functionStart = main.indexOf('const inheritUserShellEnv = async () => {');
    const functionEnd = main.indexOf('\n};', functionStart);
    const mergeLoop = main.indexOf('for (const [key, value] of Object.entries(shellEnv))', functionStart);
    const stripInside = main.indexOf('stripInheritedForeignVariables(process.env, { keep: inheritedKeep })', mergeLoop);
    const rootRewrite = main.indexOf('applyShellDataRoot({', stripInside);
    expect(functionStart).toBeGreaterThan(-1);
    expect(mergeLoop).toBeGreaterThan(functionStart);
    expect(mergeLoop).toBeLessThan(functionEnd);
    expect(stripInside).toBeGreaterThan(mergeLoop);
    expect(stripInside).toBeLessThan(functionEnd);
    expect(rootRewrite).toBeGreaterThan(stripInside);
    expect(rootRewrite).toBeLessThan(functionEnd);
  });

  it('never merges the login shell again once the shell and kernel connection have been written', async () => {
    // A second merge would strip the shell and kernel connection written since the first (docs/ENVIRONMENT.md §5.2).
    const main = readMain();
    const sliceStart = main.indexOf('let userShellEnvInherited = false;');
    const functionStart = main.indexOf('const inheritUserShellEnv = async () => {');
    const functionEnd = main.indexOf('\n};', functionStart) + '\n};'.length;
    expect(sliceStart).toBeGreaterThan(-1);
    expect(sliceStart).toBeLessThan(functionStart);

    const environment = { PATH: '/usr/bin:/bin' };
    const loginShell = { PATH: '/usr/bin:/bin', OPENCODE_CONFIG: '/probe/opencode.json', LANG: 'zh_TW.UTF-8' };
    const inheritUserShellEnv = new Function(
      'process', 'os', 'loadShellEnv', 'clearAppImageArgv0FromProcessEnv', 'pathLooksUserConfigured',
      'mergePathValues', 'stripInheritedForeignVariables', 'inheritedKeep', 'applyShellDataRoot',
      `${main.slice(sliceStart, functionEnd)}\nreturn inheritUserShellEnv;`,
    )(
      { env: environment, platform: 'darwin' },
      { homedir: () => '/Users/geo' },
      () => loginShell,
      () => {},
      () => true,
      (first) => first,
      stripInheritedForeignVariables,
      [],
      ({ environment: target }) => { target.OPENCHAMBER_DATA_DIR = '/Users/geo/data'; },
    );

    await inheritUserShellEnv();
    expect(environment.LANG).toBe('zh_TW.UTF-8');
    expect(environment).not.toHaveProperty('OPENCODE_CONFIG');

    environment.OPENCHAMBER_RUNTIME = 'desktop';
    environment.OPENCODE_HOST = 'http://127.0.0.1:4096';
    await inheritUserShellEnv();
    expect(environment.OPENCHAMBER_RUNTIME).toBe('desktop');
    expect(environment.OPENCODE_HOST).toBe('http://127.0.0.1:4096');
    expect(environment).not.toHaveProperty('OPENCODE_CONFIG');
  });

  it('keeps the UI password out of the child by prefix, with no override needed', () => {
    const next = createKernelProcessEnvironment({
      environment: { OPENCHAMBER_UI_PASSWORD: 'ui-secret', OPENCHAMBER_HOST: '0.0.0.0', PATH: '/usr/bin' },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('OPENCHAMBER_UI_PASSWORD');
    expect(next).not.toHaveProperty('OPENCHAMBER_HOST');
    expect(next.PATH).toBe('/usr/bin');
  });

  it('covers every prefix the shell reads its own configuration under', () => {
    // Comments are dropped first because shielded upstream blocks still spell the names.
    const serverRoot = new URL('../../web/server/', import.meta.url).pathname;
    const files = fs.readdirSync(serverRoot, { recursive: true })
      .filter((name) => name.endsWith('.js') && !name.includes('.test.') && !name.includes('node_modules'))
      .map((name) => path.join(serverRoot, name));
    files.push(new URL('../main.mjs', import.meta.url).pathname);
    const names = new Set();
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(match[1]);
    }
    const branded = [...names].filter((name) => /OPENCODE|OPENCHAMBER|OTEL/.test(name));
    expect(branded.length).toBeGreaterThan(50);
    expect(branded).toContain('OPENCHAMBER_DATA_DIR');
    expect(branded).toContain('OPENCODE_JWT_SECRET');
    expect(branded).toContain('OPENCODE_CONFIG_DIR');
    const uncovered = branded.filter((name) => !INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  it('names only branded launcher knobs in the allowlists, all of them set by our own scripts', () => {
    const launcher = fs.readFileSync(new URL('../scripts/electron-dev.mjs', import.meta.url).pathname, 'utf8');
    for (const name of LAUNCHER_ALLOWLIST) {
      expect(INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix))).toBe(true);
      expect(launcher).toContain(name);
    }
    const fixture = fs.readFileSync(new URL('../scripts/updater-e2e-fixture.mjs', import.meta.url).pathname, 'utf8');
    for (const name of E2E_ALLOWLIST) {
      expect(INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix))).toBe(true);
      expect(fixture).toContain(name);
    }
  });

  it('lets the shell runtime skip its own login-shell merge under Electron', () => {
    // A shell-side merge would refill what main stripped; standalone serve keeps it (docs/ENVIRONMENT.md §5.2).
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
    const environment = { OPENCHAMBER_HMR_UI_PORT: '5999', OPENCHAMBER_SKIP_LOCAL_SERVER: '1', HOME: '/home/user' };
    const removed = stripInheritedForeignVariables(environment, { keep: LAUNCHER_ALLOWLIST });
    expect(removed).toEqual(['OPENCHAMBER_SKIP_LOCAL_SERVER']);
    expect(environment).toEqual({ OPENCHAMBER_HMR_UI_PORT: '5999', HOME: '/home/user' });
  });

  it('strips the shell knobs a user-installed OpenChamber would have exported', () => {
    const environment = {
      OPENCHAMBER_SKIP_LOCAL_SERVER: '1',
      OPENCHAMBER_OPENCODE_CWD: '/tmp/attacker-cwd',
      OPENCHAMBER_SERVER_URL: 'https://remote.example',
      OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN: 'true',
      ANTHROPIC_API_KEY: 'sk-user',
    };
    stripInheritedForeignVariables(environment);
    expect(environment).toEqual({ ANTHROPIC_API_KEY: 'sk-user' });
  });

  it('drops the runtime switches that change what code the child runs, per platform', () => {
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

  it('takes the browser plugin from overrides alone, so a failed preparation leaves the kernel without one', () => {
    const stale = 'file:///previous/run/geocode-browser-plugin.js';
    const inherited = createKernelProcessEnvironment({
      environment: { [BROWSER_PLUGIN_ENV]: stale },
      platform: 'darwin',
    });
    expect(inherited).not.toHaveProperty(BROWSER_PLUGIN_ENV);

    const prepared = createKernelProcessEnvironment({
      environment: { [BROWSER_PLUGIN_ENV]: stale },
      platform: 'darwin',
      overrides: { [BROWSER_PLUGIN_ENV]: 'file:///this/run/geocode-browser-plugin.js' },
    });
    expect(prepared[BROWSER_PLUGIN_ENV]).toBe('file:///this/run/geocode-browser-plugin.js');
  });

  it('lists the name browser-tool.mjs actually injects, which a rename would otherwise leave behind', () => {
    expect(INJECTED_ONLY).toContain(BROWSER_PLUGIN_ENV);
  });

  it('never carries a password, which travels over IPC instead', () => {
    const next = createKernelProcessEnvironment({
      environment: { OPENCODE_SERVER_PASSWORD: 'inherited-secret' },
      platform: 'darwin',
    });
    expect(next).not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
  });
});

describe('environment-boundary.mjs', () => {
  it('strips this very process at import, treating anything but a real dev launch as packaged', async () => {
    process.env.OPENCHAMBER_PROBE_STRIPPED = '1';
    process.env.OPENCODE_PROBE_STRIPPED = '1';
    process.env.OPENCHAMBER_HMR_UI_PORT = '5999';
    process.env.OPENCHAMBER_E2E = '1';
    process.env.GEOCODE_PROBE_KEPT = '1';
    try {
      const { inheritedKeep } = await import('./environment-boundary.mjs');
      expect(inheritedKeep).toEqual(E2E_ALLOWLIST);
      expect(process.env).not.toHaveProperty('OPENCHAMBER_PROBE_STRIPPED');
      expect(process.env).not.toHaveProperty('OPENCODE_PROBE_STRIPPED');
      expect(process.env).not.toHaveProperty('OPENCHAMBER_HMR_UI_PORT');
      expect(process.env.OPENCHAMBER_E2E).toBe('1');
      expect(process.env.GEOCODE_PROBE_KEPT).toBe('1');
    } finally {
      for (const key of ['OPENCHAMBER_E2E', 'GEOCODE_PROBE_KEPT']) delete process.env[key];
    }
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
