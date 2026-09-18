/* --- GeoCode: keeps the Claude provider out of the quota registry. An upstream merge restoring the entry
 * fails nothing else, and its only symptom is a Keychain prompt. --- */
import { describe, expect, it } from 'vitest';

import { fetchClaudeQuota, fetchQuotaForProvider } from './index.js';

describe('Claude quota provider removal', () => {
  it('answers the registry route as an unknown provider, not as an unconfigured one', async () => {
    expect((await fetchQuotaForProvider('claude')).error).toBe('Unsupported provider');
  });

  it('closes the named passthrough, which reached the provider without the registry', async () => {
    expect((await fetchClaudeQuota()).error).toBe('Unsupported provider');
  });
});
