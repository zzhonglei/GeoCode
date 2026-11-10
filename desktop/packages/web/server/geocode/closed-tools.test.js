import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManagedConfigRuntime } from '../lib/opencode/managed-config-file.js';

const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-closed-tools-'));

afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

// Guards against a merge giving an agent the secret or the workflow tool again.
describe('GeoCode: closed agent tools', () => {
  it('gives the kernel neither the secret nor the workflow tool, even when settings.json turns them on', async () => {
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
      readSettings: async () => ({ agentSecretToolEnabled: true, agentWorkflowToolEnabled: true }),
    });
    await runtime.refreshManagedConfigFile();
    expect(asked).toEqual([expect.objectContaining({ includeSecret: false, includeWorkflow: false })]);
  });
});
