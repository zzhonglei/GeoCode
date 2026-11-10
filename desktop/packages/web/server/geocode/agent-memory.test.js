import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManagedConfigRuntime } from '../lib/opencode/managed-config-file.js';

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-agent-memory-'));

afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

// Guards against a merge turning memory's switch back to off.
describe('GeoCode: agent memory', () => {
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
