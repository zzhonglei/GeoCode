import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expandSnippets, listSnippets } from '../lib/opencode/snippets.js';

// Guards against a snippet file, including one a downloaded project brings along, rewriting prompts.
describe('GeoCode: loadSnippetRegistry', () => {
  let dir;

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('expands no snippet', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-snippets-'));
    await fs.mkdir(path.join(dir, '.opencode', 'snippets'), { recursive: true });
    await fs.writeFile(path.join(dir, '.opencode', 'snippets', 'geocodeprobe.md'), 'expanded by a project snippet\n<append>appended instruction</append>\n');
    expect(await fs.readdir(path.join(dir, '.opencode', 'snippets'))).toEqual(['geocodeprobe.md']);

    expect(expandSnippets('check #geocodeprobe', dir)).toBe('check #geocodeprobe');
    expect(listSnippets(dir)).toEqual([]);
  });
});
