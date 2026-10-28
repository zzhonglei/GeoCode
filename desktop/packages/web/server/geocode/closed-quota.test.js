import { afterEach, describe, expect, it, vi } from 'vitest';

// Guards against the upstream tables being rebuilt without the wrapper.
describe('GeoCode: withoutClosedQuotaProviders', () => {
  afterEach(() => {
    vi.doUnmock('../lib/quota/providers/claude/index.js');
    vi.doUnmock('../lib/quota/providers/cursor.js');
    vi.resetModules();
  });

  it('answers Claude and Cursor as unsupported without reading their credentials', async () => {
    // Stubs, so a broken guard fails here instead of reading this machine's Keychain.
    const read = vi.fn(async () => ({ ok: true }));
    for (const specifier of ['../lib/quota/providers/claude/index.js', '../lib/quota/providers/cursor.js']) {
      vi.doMock(specifier, async (original) => ({ ...(await original()), isConfigured: read, fetchQuota: read }));
    }
    const { fetchQuotaForProvider } = await import('../lib/quota/providers/index.js');
    const { normalizers } = await import('../lib/quota/credentials/providers.js');

    for (const providerId of ['claude', 'cursor']) {
      const result = await fetchQuotaForProvider(providerId);
      expect(result).toMatchObject({ ok: false, configured: false });
    }
    expect(read).not.toHaveBeenCalled();
    expect(normalizers).not.toHaveProperty('cursor');
  });
});
