import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assessOpenCodeConfig } from '../lib/opencode-trust/assessment.js';
import { kernelConfigDir } from './kernel-paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-folder-trust-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const folder = (name, files) => {
  const directory = path.join(root, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), text);
  }
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

const mcp = JSON.stringify({ mcp: { tiles: { type: 'local', command: ['node', 'tiles.js'] } } });
const kinds = async (directory) => (await assessOpenCodeConfig(directory)).items.map((item) => `${item.kind} ${item.source}`);

// Guards against the trust question missing what the kernel runs from a folder, or asking for what it never runs:
// the kernel reads geocode.json(c) and .geocode/ of the folder itself, and loads no project plugin.
describe('GeoCode: folder trust', () => {
  it("asks for the commands in the folder's own kernel configuration", async () => {
    expect(await kinds(folder('own', { 'geocode.json': mcp, '.geocode/geocode.jsonc': JSON.stringify({ formatter: { r: { command: ['styler'] } } }) })))
      .toEqual(['formatter .geocode/geocode.jsonc', 'mcp geocode.json']);
  });

  it("does not ask for another product's configuration", async () => {
    expect(await kinds(folder('other', { 'opencode.json': mcp, '.opencode/opencode.json': mcp, '.opencode/plugins/tool.js': '' }))).toEqual([]);
  });

  it('does not ask for a configuration above the folder', async () => {
    folder('parent', { 'geocode.json': mcp });
    expect(await kinds(folder('parent/child', {}))).toEqual([]);
  });

  it('does not ask for plugins, which the kernel loads from the managed configuration alone', async () => {
    expect(await kinds(folder('plugins', { 'geocode.json': JSON.stringify({ plugin: ['./tool.js'] }), 'tool.js': '', '.geocode/plugins/tool.js': '' }))).toEqual([]);
  });

  it("treats the kernel's global configuration directory as the user's own", async () => {
    const directory = kernelConfigDir();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'geocode.json'), mcp);
    try {
      expect(await kinds(directory)).toEqual([]);
    } finally {
      fs.rmSync(path.join(directory, 'geocode.json'));
    }
  });
});
