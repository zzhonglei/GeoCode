import { afterEach, describe, expect, it, vi } from 'vitest';

import { withoutClosedQuotaProviders } from './closed-quota.js';

// Guards against the upstream tables being rebuilt without the wrapper.
describe('GeoCode: withoutClosedQuotaProviders', () => {
  const originalElectron = process.versions.electron;

  afterEach(() => {
    if (originalElectron === undefined) delete process.versions.electron;
    else process.versions.electron = originalElectron;
    vi.doUnmock('../lib/quota/providers/claude/index.js');
    vi.doUnmock('../lib/quota/providers/cursor.js');
    vi.resetModules();
  });

  it('leaves the tables whole outside the desktop app', () => {
    delete process.versions.electron;
    expect(Object.keys(withoutClosedQuotaProviders({ claude: 1, cursor: 2, codex: 3 }))).toEqual(['claude', 'cursor', 'codex']);
  });

  it('answers Claude and Cursor as unsupported without reading their credentials', async () => {
    process.versions.electron = 'test';
    vi.resetModules();
    // Stubs, so a broken guard fails here instead of reading this machine's Keychain.
    for (const specifier of ['../lib/quota/providers/claude/index.js', '../lib/quota/providers/cursor.js']) {
      vi.doMock(specifier, async (original) => ({ ...(await original()), isConfigured: () => true, fetchQuota: async () => ({ error: 'read' }) }));
    }
    const { fetchQuotaForProvider } = await import('../lib/quota/providers/index.js');
    const { normalizers } = await import('../lib/quota/credentials/providers.js');

    for (const providerId of ['claude', 'cursor']) {
      const result = await fetchQuotaForProvider(providerId);
      expect(result.error).toBe('Unsupported provider');
    }
    expect(normalizers).not.toHaveProperty('cursor');
  });
});
