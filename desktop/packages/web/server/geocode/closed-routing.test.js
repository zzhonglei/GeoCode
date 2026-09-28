import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRoutingRuntime } from '../lib/routing/runtime.js';
import { createRoutingStore, resolveEffectiveConfig } from '../lib/routing/store.js';

// Guards against a routing.json left by OpenChamber sending turns or permissions to Jev from the desktop app.
describe('GeoCode: readConfig', () => {
  const originalElectron = process.versions.electron;
  let dir;

  afterAll(async () => {
    if (originalElectron === undefined) delete process.versions.electron;
    else process.versions.electron = originalElectron;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('ignores a stored config only inside the desktop app', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-routing-'));
    const store = createRoutingStore({ dataDir: dir });
    const config = resolveEffectiveConfig(null);
    config.enabled = true;
    config.fallback = { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' };
    config.safetyNet = { enabled: true, threshold: 0.6 };
    await store.writeConfig(config);

    const jev = { ask: vi.fn(async () => ({ answers: {}, ms: 1 })) };
    const runtime = createRoutingRuntime({
      dataDir: dir,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      store,
      jev,
    });
    const permission = { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['rm -rf data'] };

    delete process.versions.electron;
    await runtime.evaluatePermission(permission, dir);
    expect(jev.ask).toHaveBeenCalledTimes(1);

    process.versions.electron = 'test';
    runtime.forgetPermission(permission.id);
    expect(await runtime.evaluatePermission(permission, dir)).toMatchObject({ action: 'accept' });
    expect(jev.ask).toHaveBeenCalledTimes(1);
    await expect(runtime.resolveAutoSelection({ sessionId: 'ses_1', directory: dir, model: { providerID: 'openchamber', id: 'auto' } }))
      .rejects.toThrow();
    expect(jev.ask).toHaveBeenCalledTimes(1);
  });
});
