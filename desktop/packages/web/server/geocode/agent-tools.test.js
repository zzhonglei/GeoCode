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
const TOOLS = ['geocode', 'geocode_schedule', 'geocode_web', 'geocode_memory', 'geocode_knowledge', 'geocode_notify', 'geocode_render', 'geocode_image'];
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-agent-tools-'));

afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

const pluginSource = async () => {
  const runtime = createAgentToolRuntime({ crypto, fsPromises: fs.promises, path, instanceDir, getActivePort: () => 1 });
  const directory = await runtime.materializePlugin({ includeControl: true, includeSchedule: true, includeWeb: true, includeMemory: true, includeKnowledge: true, includeNotify: true, includeRender: true, includeImage: true });
  return fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
};

describe('GeoCode: agent tools', () => {
  it('registers the tools under GeoCode names', async () => {
    const source = await pluginSource();
    expect([...source.matchAll(/tools\.add\(\{\s*name: "([^"]+)"/g)].map((match) => match[1])).toEqual(TOOLS);
  });

  it('resolves a bare action through the name of the tool that asked', () => {
    // `delete` belongs to both the schedule and the memory actions, so only the tool's name settles it.
    expect(resolveAgentToolAction('delete', 'geocode_memory')).toEqual({ action: 'memory.delete' });
    expect(resolveAgentToolAction('delete', 'geocode_schedule')).toEqual({ action: 'schedule.delete' });
    expect(resolveAgentToolAction('delete', 'openchamber_memory').action).toBeUndefined();
  });

  it('is matched under the same names by the interface', () => {
    for (const file of [
      'ui/src/components/sections/agents/agentPermissionModel.ts',
      'ui/src/components/chat/message/parts/ToolPart.tsx',
      'ui/src/components/chat/message/parts/toolPresentation.tsx',
      'ui/src/lib/toolHelpers.ts',
      'ui/src/lib/opencode/tools.ts',
      'ui/src/hooks/useAssistantStatus.ts',
    ]) {
      const source = fs.readFileSync(path.join(packages, file), 'utf8');
      for (const tool of TOOLS) expect(source, `${file} names ${tool}`).toMatch(new RegExp(`(?:['"]${tool}['"]|\\b${tool}:)`));
      // Upstream's comments still name the tools as upstream does; a name in the code is what would break.
      expect(source, file).not.toMatch(/['"]openchamber_(?:schedule|web|memory|knowledge|notify|render|image)['"]|\bopenchamber_(?:schedule|web|memory|knowledge|notify|render|image):/);
    }
  });

  // The server lets the chat read a file only when a call of these tools in the message made it.
  it('lets the chat show what the render and image tools made', () => {
    const source = fs.readFileSync(path.join(packages, 'web/server/lib/markdown-image-grants/routes.js'), 'utf8');
    expect(source).toContain("part.name !== 'geocode_render'");
    expect(source).toContain("part.name !== 'geocode_image'");
    expect(source).not.toMatch(/['"]openchamber_(?:render|image)['"]/);
  });
});
