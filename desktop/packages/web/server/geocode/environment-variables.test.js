import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createEnvironmentRuntime } from '../lib/environment/runtime.js';
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
