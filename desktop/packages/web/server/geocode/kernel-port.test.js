import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOpenCodeLifecycleRuntime } from '../lib/opencode/lifecycle.js';

describe('GeoCode: the kernel is not found by its port', () => {
  const cleanup = [];
  const saved = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  afterEach(async () => {
    // Last registered first: Windows cannot remove the folder a process still running works in.
    for (const step of cleanup.splice(0).reverse()) await step();
    if (saved === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = saved;
  });

  // After the kernel exits, its old port can be taken by any program: a restart that cleans up by port would kill it.
  it('leaves the new owner of the old port alive across a restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-kernel-port-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, 'registry');
    await fs.writeFile(path.join(root, 'serve'), `
      const server = require('node:net').createServer((socket) => socket.end());
      server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', () => {
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
      setOpenCodePort: (port) => { state.openCodePort = port; },
      setDetectedOpenCodeApiPrefix: noop,
      waitForReady: async () => true,
      topUpV1SessionMigration: () => ({ status: 'skipped' }),
    });

    state.openCodeProcess = await runtime.startOpenCode();
    cleanup.push(() => state.openCodeProcess?.close());
    const oldPort = state.openCodePort;
    await state.openCodeProcess.close();

    const owner = spawn(process.execPath, ['-e', `require('node:net').createServer((s) => s.end()).listen(${oldPort}, '127.0.0.1', () => process.stdout.write('ready'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanup.push(() => owner.kill('SIGKILL'));
    await once(owner.stdout, 'data');

    await runtime.restartOpenCode();
    expect({ exitCode: owner.exitCode, signalCode: owner.signalCode }).toEqual({ exitCode: null, signalCode: null });
  }, 30000);
});
