import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentToolRuntime } from '../lib/agent-tool/runtime.js';
import { resolveAgentToolAction } from '../lib/openchamber-control/actions.js';

// Guards against the tool names drifting apart: the plugin registers them, the control service resolves
// actions by them, and the interface matches them by name to render calls and list permission rules.
const TOOLS = ['geocode', 'geocode_web', 'geocode_memory', 'geocode_notify'];
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-agent-tools-'));

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const pluginSource = async () => {
  const runtime = createAgentToolRuntime({ crypto, fsPromises: fs.promises, path, dataDir, getActivePort: () => 1 });
  const directory = await runtime.materializePlugin({ includeControl: true, includeWeb: true, includeMemory: true, includeNotify: true });
  return fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
};

describe('GeoCode: agent tools', () => {
  it('registers the tools under GeoCode names and describes them without OpenChamber', async () => {
    const source = await pluginSource();
    expect([...source.matchAll(/tools\.add\(\{\s*name: "([^"]+)"/g)].map((match) => match[1])).toEqual(TOOLS);
    expect(source).not.toMatch(/"[^"\n]*OpenChamber[^"\n]*"/);
  });

  it('resolves a bare action through the name of the tool that asked', () => {
    // `delete` belongs to both the schedule and the memory actions, so only the tool's name settles it.
    expect(resolveAgentToolAction('delete', 'geocode_memory')).toEqual({ action: 'memory.delete' });
    expect(resolveAgentToolAction('delete', 'openchamber_memory').action).toBeUndefined();
  });

  it('is matched under the same names by the interface', () => {
    for (const file of [
      'ui/src/components/sections/agents/agentPermissionModel.ts',
      'ui/src/components/chat/message/parts/ToolPart.tsx',
      'ui/src/components/chat/message/parts/toolPresentation.tsx',
      'ui/src/lib/toolHelpers.ts',
    ]) {
      const source = fs.readFileSync(path.join(packages, file), 'utf8');
      for (const tool of TOOLS) expect(source, `${file} names ${tool}`).toMatch(new RegExp(`(?:'${tool}'|\\b${tool}:)`));
      expect(source, file).not.toMatch(/openchamber_(?:web|memory|notify)/);
    }
  });
});
