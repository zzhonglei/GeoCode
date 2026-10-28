import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createEnvironmentRuntime } from '../lib/environment/runtime.js';
import { createOpenCodeLifecycleRuntime } from '../lib/opencode/lifecycle.js';
import { createTerminalRuntime } from '../lib/terminal/runtime.js';

// Guards against Settings handing the kernel a variable that moves its configuration, loads a binary or turns on telemetry.
describe('GeoCode: environment variables', () => {
  it('gives the kernel the user variables without the app prefixes', () => {
    const runtime = createEnvironmentRuntime({
      store: { userVariables: () => ({ GDAL_DATA: '/gdal', OPENCODE_CONFIG_DIR: '/elsewhere', BUN_INSTALL: '/bun' }) },
      listProjects: () => [],
      readOpenCodeServiceEnv: () => ({ PROJ_DATA: '/proj', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' }),
      isEnterpriseMode: () => false,
    });
    expect(runtime.forOpenCode()).toEqual({ GDAL_DATA: '/gdal', PROJ_DATA: '/proj' });
  });

  // Guards against Settings moving the kernel's files, and the user's tools', away from where the shell keeps its own.
  it('hands no consumer the home or temporary directories from Settings', async () => {
    const runtime = createEnvironmentRuntime({
      store: {
        userVariables: () => ({ GDAL_DATA: '/gdal', HOME: '/h', USERPROFILE: '/h', TMPDIR: '/t', TMP: '/t', TEMP: '/t' }),
        projectEntry: () => null,
      },
      listProjects: () => [],
      readOpenCodeServiceEnv: () => ({ HOME: '/service' }),
      isEnterpriseMode: () => false,
    });
    expect(runtime.forOpenCode()).toEqual({ GDAL_DATA: '/gdal' });
    expect(await runtime.forDirectory('/project', { refresh: false })).toEqual({ GDAL_DATA: '/gdal' });
  });

  // Guards against an OpenChamber the user installed, run by the agent, taking the shell's own directories for its own.
  it('starts the kernel without the shell directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-kernel-env-'));
    const saved = { data: process.env.OPENCHAMBER_DATA_DIR, registry: process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY };
    process.env.OPENCHAMBER_DATA_DIR = path.join(root, 'desktop');
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, 'desktop', 'managed-kernel');
    // A kernel that writes down the variables it was started with.
    await fs.writeFile(path.join(root, 'serve'), `
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'env.json'))}, JSON.stringify(process.env));
      const server = require('node:net').createServer((socket) => socket.end());
      server.listen(0, '127.0.0.1', () => {
        process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port }) + '\\n');
      });
      process.stdin.resume();
      process.stdin.on('end', () => server.close(() => process.exit(0)));
    `);
    const state = { openCodeWorkingDirectory: root, useWslForOpencode: false };
    const noop = () => {};
    const runtime = createOpenCodeLifecycleRuntime({
      state,
      env: { ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
      syncToHmrState: noop,
      syncFromHmrState: noop,
      checkOpenCodeBinary: async () => '2.0.28',
      ensureOpencodeCliEnv: () => process.execPath,
      applyOpencodeBinaryFromSettings: async () => {},
      ensureLocalOpenCodeServerPassword: async () => 'test-only',
      resolveManagedOpenCodeLaunchSpec: (value) => ({ binary: value, args: [] }),
      normalizeApiPrefix: (value) => value,
      setOpenCodePort: noop,
      setDetectedOpenCodeApiPrefix: noop,
      waitForReady: async () => true,
      topUpV1SessionMigration: () => ({ status: 'skipped' }),
    });
    try {
      state.openCodeProcess = await runtime.startOpenCode();
      const started = JSON.parse(await fs.readFile(path.join(root, 'env.json'), 'utf8'));
      expect(started).not.toHaveProperty('OPENCHAMBER_DATA_DIR');
      expect(started).not.toHaveProperty('OPENCHAMBER_MANAGED_PROCESS_REGISTRY');
      // As the shell gives it: what the kernel's own lines read.
      expect(started).toHaveProperty('OPENCODE_SERVER_PASSWORD', 'test-only');
    } finally {
      await state.openCodeProcess?.close();
      for (const [name, value] of [['OPENCHAMBER_DATA_DIR', saved.data], ['OPENCHAMBER_MANAGED_PROCESS_REGISTRY', saved.registry]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);

  // Guards against an OpenChamber the user installed, run in a terminal, taking the shell's own directories for its own.
  it('starts a terminal without the shell directories, whatever the project variables put back', async () => {
    const routes = new Map();
    let spawned;
    const runtime = createTerminalRuntime({
      app: { post: (route, handler) => routes.set(route, handler), get() {}, delete() {} },
      server: new EventEmitter(),
      fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
      path,
      buildAugmentedPath: () => process.env.PATH,
      searchPathFor: () => '/bin/sh',
      isExecutable: () => true,
      // A project environment command runs in the shell's environment, and may print all of it back.
      environmentRuntime: {
        applyToDirectory: async (_directory, env) => ({
          ...env,
          GDAL_DATA: '/gdal',
          OPENCHAMBER_DATA_DIR: '/geocode/desktop',
          OPENCHAMBER_MANAGED_PROCESS_REGISTRY: '/geocode/desktop/managed-kernel',
        }),
      },
      loadPtyProvider: async () => ({
        backend: 'test',
        spawn: async (_file, _args, options) => {
          spawned = options.env;
          return { pid: 0, write() {}, resize() {}, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
        },
      }),
      shutdownProcesses: async () => {},
    });
    try {
      await routes.get('/api/terminal/create')(
        { body: { sessionId: 'terminal', cwd: '/project' } },
        { status() { return this; }, json() { return this; } },
      );
    } finally {
      await runtime.shutdown();
    }
    expect(spawned).toMatchObject({ GDAL_DATA: '/gdal' });
    expect(spawned).not.toHaveProperty('OPENCHAMBER_DATA_DIR');
    expect(spawned).not.toHaveProperty('OPENCHAMBER_MANAGED_PROCESS_REGISTRY');
  });
});
