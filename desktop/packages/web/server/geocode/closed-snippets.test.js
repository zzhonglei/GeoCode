import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expandSnippets, listSnippets } from '../lib/opencode/snippets.js';

// Guards against a snippet file, including one a downloaded project brings along, rewriting prompts in the desktop app.
describe('GeoCode: loadSnippetRegistry', () => {
  const originalElectron = process.versions.electron;
  let dir;

  afterAll(async () => {
    if (originalElectron === undefined) delete process.versions.electron;
    else process.versions.electron = originalElectron;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('expands a snippet only outside the desktop app', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-snippets-'));
    await fs.mkdir(path.join(dir, '.opencode', 'snippets'), { recursive: true });
    await fs.writeFile(path.join(dir, '.opencode', 'snippets', 'geocodeprobe.md'), 'expanded by a project snippet\n<append>appended instruction</append>\n');

    delete process.versions.electron;
    expect(expandSnippets('check #geocodeprobe', dir)).toContain('expanded by a project snippet');

    process.versions.electron = 'test';
    expect(expandSnippets('check #geocodeprobe', dir)).toBe('check #geocodeprobe');
    expect(listSnippets(dir)).toEqual([]);
  });
});
