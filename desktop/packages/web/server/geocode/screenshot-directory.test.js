/* --- GeoCode: the agent writes screenshots into the user's own repository.
 *
 * `browser.capture` is the one action in the control module that touches disk, and writing the
 * image beside the code it documents is upstream's design — it survives the chat and can be
 * committed. The directory it used was `.openchamber`, so every capture put a second product's
 * directory into the user's working tree and their next commit.
 *
 * They land outside `.geocode` on purpose: that directory holds configuration a team writes by
 * hand, while these are generated and accumulate, and the two should not have to be told apart
 * in a diff. The check is on where the bytes go, not on how the constant is spelled. --- */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { KERNEL_PROJECT_DIR } from './kernel-roots.js';
import { writeScreenshot } from '../lib/openchamber-control/screenshots.js';

const PROJECT = '/work/project';

const capture = async () => {
  const made = [];
  const written = [];
  const result = await writeScreenshot({
    directory: PROJECT,
    base64: Buffer.from('image').toString('base64'),
    label: 'after fix',
    now: new Date('2026-09-01T11:31:00.000Z'),
    fs: {
      mkdir: async (target) => { made.push(target); },
      writeFile: async (target) => { written.push(target); },
    },
  });
  return { made, written, result, touched: [...made, ...written, result.path, result.absolutePath] };
};

describe('screenshot directory', () => {
  it('writes into the browser directory at the top of the project', async () => {
    const { made, written, result } = await capture();
    const expected = path.join(PROJECT, '.browser');

    expect(made).toEqual([expected]);
    expect(written).toEqual([path.join(expected, 'after-fix-2026-09-01T11-31-00-000.jpg')]);
    expect(result.path).toBe('.browser/after-fix-2026-09-01T11-31-00-000.jpg');
  });

  it('creates nothing belonging to another product', async () => {
    const { touched } = await capture();
    for (const target of touched) {
      expect(target).not.toContain('.openchamber');
      expect(target).not.toContain('.opencode');
    }
  });

  it('keeps generated images out of the directory that holds hand-written config', async () => {
    const { touched } = await capture();
    for (const target of touched) {
      expect(target).not.toContain(KERNEL_PROJECT_DIR);
    }
  });
});
