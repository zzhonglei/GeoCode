import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenCodeEnvRuntime } from '../lib/opencode/env-runtime.js';
import { createManagedProcessRegistry } from '../lib/opencode/managed-process-registry.js';
import { KERNEL_BINARY, KERNEL_PROCESS } from './kernel-paths.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('GeoCode: the kernel runs under its own name', () => {
  const children = [];
  const directories = [];
  const variables = ['OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR', 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY'];
  const saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const temporary = (prefix) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    for (const name of variables) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    Object.defineProperty(process, 'platform', platform);
  });

  // The staging script is shell and the lookup is JavaScript: a name changed in one would leave the app without a kernel.
  it('is staged under the name the shell looks for', () => {
    const script = fs.readFileSync(path.join(repo, 'scripts', 'stage-kernel.sh'), 'utf8');
    expect(/^NAME=(\S+)$/m.exec(script)?.[1]).toBe(KERNEL_PROCESS);
  });

  it('is found in the bundled directory under that name only', () => {
    const directory = temporary('geocode-kernel-name-');
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = directory;
    const upstreamName = path.join(directory, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    fs.writeFileSync(upstreamName, '#!/bin/sh\n', { mode: 0o755 });
    const runtime = createOpenCodeEnvRuntime({ state: {}, normalizeDirectoryPath: (value) => value, readSettingsFromDiskMigrated: async () => ({}) });
    expect(runtime.resolveOpencodeCliPath()).toBe(null);
    fs.writeFileSync(path.join(directory, KERNEL_BINARY), '#!/bin/sh\n', { mode: 0o755 });
    expect(runtime.resolveOpencodeCliPath()).toBe(path.join(directory, KERNEL_BINARY));
  });

  // A recycled pid may belong to an OpenCode server the user started, or to anything whose command line names the kernel: only the recorded executable is killed.
  it.skipIf(process.platform === 'win32')('reaps its own orphaned kernel and leaves other processes alone', async () => {
    const binary = `/Applications/GeoCode Beta.app/Contents/Resources/opencode-cli/${KERNEL_PROCESS}`;
    const reapWith = async (command) => {
      const registry = temporary('geocode-kernel-registry-');
      process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
      const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      children.push(child);
      fs.writeFileSync(path.join(registry, `${child.pid}.json`), JSON.stringify({ pid: child.pid, ownerPid: process.pid, port: 4096, binary }));
      const { reapOrphanedProcesses } = createManagedProcessRegistry({ execFileAsync: async () => ({ stdout: `1 ${command}\n` }) });
      const { reaped } = await reapOrphanedProcesses();
      return { reaped, alive: isAlive(child.pid) };
    };
    expect(await reapWith('/usr/local/bin/opencode serve --port 4096')).toEqual({ reaped: 0, alive: true });
    expect(await reapWith(`/tmp/${KERNEL_PROCESS}/opencode serve --port 4096`)).toEqual({ reaped: 0, alive: true });
    expect(await reapWith(`/Applications/GeoCode.app/Contents/Resources/opencode-cli/${KERNEL_PROCESS} serve --stdio --port 4096`)).toEqual({ reaped: 0, alive: true });
    expect(await reapWith(`${binary} serve --stdio --port 4096`)).toMatchObject({ reaped: 1 });
  });

  // Windows identifies a process by its image name alone, so a check left on upstream's name would never match the kernel again.
  it('reaps by image name on Windows', async () => {
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const reapWith = async (image) => {
      const registry = temporary('geocode-kernel-registry-');
      process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, ownerPid: gone, port: 4096 }));
      const killed = [];
      const execFileAsync = async (command, args) => {
        if (command === 'taskkill') killed.push(args[1]);
        return { stdout: command === 'tasklist' ? `"${image}","${process.pid}","Console","1","10,000 K"\r\n` : '' };
      };
      const { reaped } = await createManagedProcessRegistry({ execFileAsync }).reapOrphanedProcesses();
      return { reaped, killed };
    };
    expect(await reapWith('opencode.exe')).toEqual({ reaped: 0, killed: [] });
    expect(await reapWith(`other-${KERNEL_PROCESS}.exe`)).toEqual({ reaped: 0, killed: [] });
    expect(await reapWith(`${KERNEL_PROCESS}.exe`)).toEqual({ reaped: 1, killed: [String(process.pid)] });
  });
});
