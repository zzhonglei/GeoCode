/* --- GeoCode: a boot has two outcomes, and the second one reaches the window
 * (docs/DESKTOP.md §5.1).
 *
 * The record and the output tail are pinned directly; startEmbeddedKernel is driven with a
 * kernel that writes then dies, so the tail is proven to travel with the error. main.mjs is
 * pinned by source: the hosts config collapses to the local host before anything reads it,
 * the kernel start is caught rather than allowed to end the process, and the window can ask
 * for the record. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startEmbeddedKernel } from './kernel-boot.mjs';
import { KERNEL_OUTPUT_TAIL_LINES, createOutputTail, describeKernelFailure } from './kernel-failure.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');

describe('kernel failure record', () => {
  it('keeps only the last lines', () => {
    const tail = createOutputTail(3);
    for (const line of ['a', 'b', 'c', 'd']) tail.push(line);
    expect(tail.lines()).toEqual(['b', 'c', 'd']);
    expect(KERNEL_OUTPUT_TAIL_LINES).toBeGreaterThan(3);
  });

  it('describes an error with its output and the log path', () => {
    const error = Object.assign(new Error('GeoCode Kernel exited before reporting ready with code 1'), {
      kernelOutput: ['boom'],
    });
    const record = describeKernelFailure({ error, logPath: '/logs/main.log', at: new Date('2026-09-05T00:00:00Z') });
    expect(record).toEqual({
      message: 'GeoCode Kernel exited before reporting ready with code 1',
      output: ['boom'],
      logPath: '/logs/main.log',
      at: '2026-09-05T00:00:00.000Z',
    });
    expect(describeKernelFailure({ error: 'text', logPath: '' }).logPath).toBeNull();
  });

  it('startEmbeddedKernel hands the kernel output to a start failure', async () => {
    const attempt = startEmbeddedKernel({
      isDev: false,
      resourcesPath: '/app/Resources',
      fork: () => ({}),
      exists: () => true,
      cwd: '/home/user',
      environment: {},
      logger: { info: () => {}, warn: () => {} },
      startKernel: async ({ onStdout, onStderr }) => {
        onStdout('starting');
        onStderr('Error: cannot open database');
        throw new Error('GeoCode Kernel exited before reporting ready with code 1');
      },
    });
    let caught = null;
    try {
      await attempt;
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).toContain('exited before reporting ready');
    expect(caught?.kernelOutput).toEqual(['starting', 'Error: cannot open database']);
  });
});

describe('main.mjs boot', () => {
  it('has one host, this machine', () => {
    const reader = mainSource.indexOf('const readDesktopHostsConfig = () => {');
    const collapse = mainSource.indexOf("return { hosts: [], defaultHostId: LOCAL_HOST_ID, initialHostChoiceCompleted: true };", reader);
    const upstreamRead = mainSource.indexOf('const root = readSettingsRoot();', reader);
    expect(collapse).toBeGreaterThan(reader);
    expect(collapse).toBeLessThan(upstreamRead);
  });

  it('records a kernel start failure and returns without a server instead of exiting', () => {
    const start = mainSource.indexOf('state.kernelHandle = await startEmbeddedKernel({');
    const record = mainSource.indexOf('state.kernelFailure = describeKernelFailure({ error, logPath: log.transports.file.getFile().path });', start);
    const bail = mainSource.indexOf('return null;', record);
    const shellImport = mainSource.indexOf("await import('@openchamber/web/server/index.js')", start);
    expect(record).toBeGreaterThan(start);
    expect(bail).toBeGreaterThan(record);
    expect(bail).toBeLessThan(shellImport);
    // Preceded by try, so the failure is caught here and not by app.whenReady's exit.
    expect(mainSource.slice(start - 12, start)).toContain('try {');
  });

  it('answers the window with the record', () => {
    expect(mainSource).toContain("if (command === 'geocode_kernel_failure') return state.kernelFailure ?? null;");
  });
});
