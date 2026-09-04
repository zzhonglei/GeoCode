/* --- GeoCode: the server trusts the renderer's own origin (shell-identity.js).
 *
 * Two shapes again. The origin check is driven for real, because a literal that merely
 * exists in a set proves nothing about which code path consults it. The CORS middleware in
 * index.js cannot be driven without starting the whole server, so its set literal is read
 * as text instead; `desktop-identity.test.mjs` on the electron side pins the value itself
 * against the identity module. --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGED_UI_ORIGIN } from './shell-identity.js';
import { createRequestSecurityRuntime } from '../lib/security/request-security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.dirname(here);

const runtime = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
const request = (origin) => ({ headers: { origin, host: '127.0.0.1:1' }, protocol: 'http', socket: {} });

describe('packaged UI origin', () => {
  it('is accepted by the request origin check, which gates WebSocket upgrades', async () => {
    expect(await runtime.isRequestOriginAllowed(request(PACKAGED_UI_ORIGIN))).toBe(true);
  });

  it('is not a wildcard: another custom scheme is still refused', async () => {
    expect(await runtime.isRequestOriginAllowed(request('geocode-evil://app'))).toBe(false);
  });

  it('sits in both origin sets, the CORS one included', () => {
    for (const file of ['index.js', 'lib/security/request-security.js']) {
      const source = fs.readFileSync(path.join(serverRoot, file), 'utf8');
      const setStart = source.indexOf('const packagedClientOrigins = new Set([');
      const setEnd = source.indexOf(']);', setStart);
      expect(setStart).toBeGreaterThan(-1);
      expect(source.slice(setStart, setEnd)).toContain('PACKAGED_UI_ORIGIN');
    }
  });
});
