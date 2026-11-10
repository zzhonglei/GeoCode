import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManagedConfigRuntime } from '../lib/opencode/managed-config-file.js';

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-agent-tool-config-'));

afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

/** The agent tools the kernel is given for these settings. */
const toolsGiven = async (settings) => {
  const asked = [];
  const runtime = createManagedConfigRuntime({
    fsPromises: fs.promises,
    path,
    instanceDir,
    env: {},
    agentToolRuntime: {
      materializePlugin: async (options) => {
        asked.push(options);
        return path.join(instanceDir, 'agent-tool');
      },
      createChildEnv: () => ({}),
    },
    readSettings: async () => settings,
  });
  await runtime.refreshManagedConfigFile();
  return asked;
};

// Guards against a merge turning memory's switch back to off.
describe('GeoCode: agent memory', () => {
  it('gives the kernel the memory tool while the setting was never touched', async () => {
    expect(await toolsGiven({})).toEqual([expect.objectContaining({ includeMemory: true })]);
  });

  // Both read the setting where no test can reach them: the server's composition and the interface's store.
  it('defaults the setting to on where sessions are told about memory and in the interface', () => {
    const server = fs.readFileSync(path.join(packages, 'web/server/index.js'), 'utf8');
    expect(server).toContain('return settings?.agentMemoryToolEnabled !== false;');
    const store = fs.readFileSync(path.join(packages, 'ui/src/stores/useUIStore.ts'), 'utf8');
    expect(store).toMatch(/^\s*agentMemoryToolEnabled: true,/m);
  });
});

// Guards against a merge giving an agent the secret or the workflow tool again.
describe('GeoCode: closed agent tools', () => {
  it('gives the kernel neither the secret nor the workflow tool, even when settings.json turns them on', async () => {
    expect(await toolsGiven({ agentSecretToolEnabled: true, agentWorkflowToolEnabled: true }))
      .toEqual([expect.objectContaining({ includeSecret: false, includeWorkflow: false })]);
  });
});
