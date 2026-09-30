import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRoutingRuntime } from '../lib/routing/runtime.js';
import { createRoutingStore, resolveEffectiveConfig } from '../lib/routing/store.js';

// Guards against routing files left by OpenChamber sending turns or permissions to Jev.
describe('GeoCode: readClassifierSource', () => {
  let dir;

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives Jev no endpoint whatever was stored', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-routing-'));
    const store = createRoutingStore({ dataDir: dir });
    const config = resolveEffectiveConfig(null);
    config.enabled = true;
    config.fallback = { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' };
    config.safetyNet = { enabled: true, threshold: 0.6 };
    await store.writeConfig(config);
    await store.writeToken('typesafe-key');
    await store.writeClassifierSource('openrouter');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'classification.json'), 'utf8'))).toMatchObject({ source: 'openrouter' });

    const jev = { ask: vi.fn(async () => ({ answers: {}, ms: 1 })) };
    // Every source is usable, so only the stored pick decides.
    const runtime = createRoutingRuntime({
      dataDir: dir,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      store,
      jev,
      readProviderKeys: () => ({ zenKey: 'zen', openrouterKey: 'or', vercelKey: 'vc' }),
      zenPromotionActive: true,
      enterpriseMode: () => false,
      readPinnedEndpoint: () => ({ url: 'https://jev.example.com/v1/systemone', model: 'jev-latest' }),
    });
    const permission = { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['rm -rf data'] };

    expect(await runtime.classifierEndpoint()).toBeNull();
    expect(await runtime.evaluatePermission(permission, dir)).toMatchObject({ action: 'hold', unavailable: true });
    await expect(runtime.resolveAutoSelection({ sessionId: 'ses_1', directory: dir, model: { providerID: 'openchamber', id: 'auto' } }))
      .rejects.toThrow();
    expect(jev.ask).not.toHaveBeenCalled();
  });
});
