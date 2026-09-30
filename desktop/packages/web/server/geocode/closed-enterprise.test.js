import { describe, expect, it, vi } from 'vitest';

import { isEnterpriseMode, publicEnterprisePolicy, readEnterprisePolicy } from '../lib/enterprise-mode.js';

// Guards against an OpenChamber policy file or variable locking GeoCode's provider settings.
describe('GeoCode: readEnterprisePolicy', () => {
  it('stays off with a policy file and the variables set', () => {
    const readFile = vi.fn(() => JSON.stringify({ enterpriseMode: true, organization: 'Org', jev: { url: 'https://jev.example.com' } }));
    const env = { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_JEV_URL: 'https://jev.example.com', OPENCHAMBER_RELAY_URL: 'wss://relay.example.com' };
    const options = { platform: 'darwin', env, readFile };

    expect(readEnterprisePolicy(options)).toMatchObject({ enterpriseMode: false, jev: null, relayUrl: null, organization: null });
    expect(isEnterpriseMode(options)).toBe(false);
    expect(publicEnterprisePolicy(options)).toMatchObject({ enterpriseMode: false, networkAccessBlocked: false });
    expect(readFile).not.toHaveBeenCalled();
  });
});
