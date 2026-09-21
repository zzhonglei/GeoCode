import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickFreePort } from './kernel-host.mjs';
import { KERNEL_MESSAGE, createStartCommand, createStopCommand, parseKernelMessage } from './kernel-protocol.mjs';

/* The sidecar turns a signal into an exit, and only an exit runs the kernel's sweep (docs/GEOKERNEL.md §10.1 #8b). */

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelPackage = path.resolve(here, '../../../../kernel/packages/opencode');
const TOOLS = ['gdalinfo', 'gdalwarp', 'gdal_translate', 'gdaldem', 'ogrinfo', 'ogr2ogr'];
const PASSWORD = 'sidecar-sweep';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(100);
  }
  return condition();
};

const readPid = (file) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : 0);

const startSidecar = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-sidecar-'));
  const staged = path.join(root, 'kernel');
  fs.mkdirSync(staged);
  for (const file of ['kernel-sidecar.mjs', 'kernel-protocol.mjs']) {
    fs.copyFileSync(path.join(here, file), path.join(staged, file));
  }
  fs.writeFileSync(path.join(staged, 'node.js'), `export { Server } from ${JSON.stringify(path.join(kernelPackage, 'src/node.ts'))};\n`);

  const bin = path.join(root, 'bin');
  const pidFile = path.join(root, 'child.pid');
  fs.mkdirSync(bin);
  for (const tool of TOOLS) {
    // `exec` replaces the shell, so the recorded pid IS the process that must not survive.
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 400\n`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  fs.mkdirSync(path.join(root, 'config', 'GeoCode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'GeoCode', 'machine.json'), JSON.stringify({ gdal: bin }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'scene.tif'), 'pixels');

  const port = await pickFreePort({ hostname: '127.0.0.1' });
  const proc = Bun.spawn([process.execPath, path.join(staged, 'kernel-sidecar.mjs')], {
    cwd: kernelPackage,
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    // Not piped: nothing reads it, and a full pipe buffer would stall the kernel mid-boot.
    stderr: 'ignore',
  });

  const messages = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let index = buffered.indexOf('\n');
      while (index >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        try {
          const message = parseKernelMessage(JSON.parse(line));
          if (message) messages.push(message);
        } catch {
          // Kernel output that is not a protocol message.
        }
        index = buffered.indexOf('\n');
      }
    }
  })();

  proc.stdin.write(`${JSON.stringify(createStartCommand({ hostname: '127.0.0.1', port, password: PASSWORD }))}\n`);
  proc.stdin.flush();

  const settled = await waitFor(
    () => messages.some((message) => message.type === KERNEL_MESSAGE.READY || message.type === KERNEL_MESSAGE.ERROR),
    60_000,
  );
  const failure = messages.find((message) => message.type === KERNEL_MESSAGE.ERROR);
  if (!settled || failure) {
    proc.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(failure ? `kernel failed to start: ${failure.error.message}` : 'kernel never reported ready');
  }

  const cleanup = () => {
    proc.kill('SIGKILL');
    const recorded = readPid(pidFile);
    if (recorded && alive(recorded)) process.kill(recorded, 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { proc, port, project, pidFile, cleanup };
};

const startGeographicProcess = async ({ port, project, pidFile }) => {
  const authorization = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  // Meant to hang, since the fake toolchain never returns, so it is bounded and never awaited.
  void fetch(`http://127.0.0.1:${port}/geo/raster/meta?path=scene.tif&directory=${encodeURIComponent(project)}`, {
    headers: { authorization },
    signal: AbortSignal.timeout(60_000),
  }).catch(() => undefined);
  await waitFor(() => readPid(pidFile) > 0 && alive(readPid(pidFile)), 30_000);
  return readPid(pidFile);
};

const it_ = process.platform === 'win32' ? it.skip : it;

describe('kernel sidecar shutdown', () => {
  it('STOP exits through the cleanup hook without waiting for a stuck listener', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-sidecar-stop-'));
    for (const file of ['kernel-sidecar.mjs', 'kernel-protocol.mjs']) {
      fs.copyFileSync(path.join(here, file), path.join(root, file));
    }
    const ready = path.join(root, 'ready');
    const swept = path.join(root, 'swept');
    fs.writeFileSync(path.join(root, 'node.js'), `
      import fs from 'node:fs';
      process.on('exit', () => fs.writeFileSync(${JSON.stringify(swept)}, 'done'));
      export const Server = { listen: async () => {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        return { hostname: '127.0.0.1', port: 12345, stop: () => new Promise(() => {}) };
      } };
    `);
    const proc = Bun.spawn([process.execPath, path.join(root, 'kernel-sidecar.mjs')], {
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    });
    try {
      proc.stdin.write(`${JSON.stringify(createStartCommand({ hostname: '127.0.0.1', port: 12345, password: '' }))}\n`);
      proc.stdin.flush();
      expect(await waitFor(() => fs.existsSync(ready), 5_000)).toBe(true);
      proc.stdin.write(`${JSON.stringify(createStopCommand())}\n`);
      proc.stdin.flush();
      expect(await waitFor(() => proc.exitCode !== null, 3_000)).toBe(true);
      expect(proc.exitCode).toBe(0);
      expect(fs.readFileSync(swept, 'utf8')).toBe('done');
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await proc.exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const method of ['ipc', 'signal']) it_(`${method} shutdown takes a running geographic process down with the kernel`, async () => {
    const sidecar = await startSidecar();
    try {
      const child = await startGeographicProcess(sidecar);
      expect(alive(child)).toBe(true);

      if (method === 'signal') sidecar.proc.kill('SIGTERM');
      else {
        sidecar.proc.stdin.write(`${JSON.stringify(createStopCommand())}\n`);
        sidecar.proc.stdin.flush();
      }
      // Well inside the kernel's own 30s clock on the read, so only the sweep can explain a death here.
      expect(await waitFor(() => !alive(child), 10_000)).toBe(true);
      expect(await waitFor(() => sidecar.proc.exitCode !== null, 10_000)).toBe(true);
    } finally {
      sidecar.cleanup();
    }
    // Boot 60s + spawn 30s + two 10s waits = 110s, which this limit has to exceed so a failure names its step.
  }, 150_000);
});
