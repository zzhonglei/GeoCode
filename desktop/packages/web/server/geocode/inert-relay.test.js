/* --- GeoCode: under Electron `createRelayService` returns our inert object instead of upstream's, and its
 * callers cannot tell. A method upstream adds and calls would then be undefined at startup, which is a
 * crash rather than a missing feature (docs/DESKTOP.md §7.3). --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInertRelayService } from './inert-relay.js';

const SERVICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/relay/service.js');

// Read out of the real service rather than listed here: a list would agree with itself while the two
// objects drifted apart.
const upstreamMethodNames = () => {
  const source = fs.readFileSync(SERVICE, 'utf8');
  const start = source.lastIndexOf('\n  return {');
  const block = source.slice(start, source.indexOf('};', start));
  return [...block.matchAll(/^\s{4}([A-Za-z_$][\w$]*),$/gm)].map((match) => match[1]);
};

describe('the inert relay service', () => {
  it('answers to every method the real one returns', () => {
    const upstream = upstreamMethodNames();
    // Guards the reader itself: an empty list would make the comparison below hold for anything.
    expect(upstream.length).toBeGreaterThan(4);
    expect(Object.keys(createInertRelayService()).sort()).toEqual([...upstream].sort());
  });

  it('answers each of them without reaching anything', async () => {
    const service = createInertRelayService();
    for (const [name, value] of Object.entries(service)) {
      expect([name, typeof value]).toEqual([name, 'function']);
    }
    expect(await service.getStatus()).toMatchObject({ enabled: false, state: 'disabled', relayUrl: null });
    expect(await service.getServerId()).toBe(null);
    expect(await service.getPairingCandidate()).toBe(null);
  });
});
