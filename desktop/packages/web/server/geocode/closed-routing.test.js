import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRoutingRuntime } from '../lib/routing/runtime.js';
import { createRoutingStore, resolveEffectiveConfig } from '../lib/routing/store.js';

// Guards against a routing.json left by OpenChamber sending turns or permissions to Jev.
describe('GeoCode: readConfig', () => {
  let dir;

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('ignores a stored config', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-routing-'));
    const store = createRoutingStore({ dataDir: dir });
    const config = resolveEffectiveConfig(null);
    config.enabled = true;
    config.fallback = { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' };
    config.safetyNet = { enabled: true, threshold: 0.6 };
    await store.writeConfig(config);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'routing.json'), 'utf8'))).toMatchObject({ enabled: true });

    const jev = { ask: vi.fn(async () => ({ answers: {}, ms: 1 })) };
    const runtime = createRoutingRuntime({
      dataDir: dir,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      store,
      jev,
    });
    const permission = { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['rm -rf data'] };

    expect(await runtime.evaluatePermission(permission, dir)).toMatchObject({ action: 'accept' });
    await expect(runtime.resolveAutoSelection({ sessionId: 'ses_1', directory: dir, model: { providerID: 'openchamber', id: 'auto' } }))
      .rejects.toThrow();
    expect(jev.ask).not.toHaveBeenCalled();
  });
});
