import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAgentMemoryFeatureAvailable } from '../lib/agent-memory/feature-flag.js';
import { createManagedConfigRuntime } from '../lib/opencode/managed-config-file.js';

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-agent-memory-'));

afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

// Guards against a merge putting memory back behind upstream's unreleased flag, or its switch back to off.
describe('GeoCode: agent memory', () => {
  it('is available without the variable upstream ships it behind', () => {
    const saved = process.env.OPENCHAMBER_MEMORY_ENABLE;
    delete process.env.OPENCHAMBER_MEMORY_ENABLE;
    try {
      expect(isAgentMemoryFeatureAvailable()).toBe(true);
    } finally {
      if (saved !== undefined) process.env.OPENCHAMBER_MEMORY_ENABLE = saved;
    }
  });

  it('gives the kernel the memory tool while the setting was never touched', async () => {
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
      readSettings: async () => ({}),
      isAgentMemoryAvailable: isAgentMemoryFeatureAvailable,
    });
    await runtime.refreshManagedConfigFile();
    expect(asked).toEqual([expect.objectContaining({ includeMemory: true })]);
  });

  // Both read the setting where no test can reach them: the server's composition and the interface's store.
  it('defaults the setting to on where sessions are told about memory and in the interface', () => {
    const server = fs.readFileSync(path.join(packages, 'web/server/index.js'), 'utf8');
    expect(server).toContain('return settings?.agentMemoryToolEnabled !== false;');
    const store = fs.readFileSync(path.join(packages, 'ui/src/stores/useUIStore.ts'), 'utf8');
    expect(store).toMatch(/^\s*agentMemoryToolEnabled: true,/m);
  });
});
