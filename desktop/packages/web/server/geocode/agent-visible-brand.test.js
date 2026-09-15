/* --- GeoCode: two messages the shell hands the agent name the product, and the name is GeoCode
 * (docs/DESKTOP.md §7.2). --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBrowserControlBroker } from '../lib/browser-control/broker.js';

describe('messages the agent reads from the shell', () => {
  it('the browser tool answers a call no window can serve under GeoCode', async () => {
    const broker = createBrowserControlBroker({ emitRequest: () => 0 });
    const error = await broker.request('browser.click', { selector: '#a' }).catch((caught) => caught);
    expect(error.status).toBe(503);
    expect(error.message).toContain('GeoCode');
    expect(error.message).not.toMatch(/OpenChamber|OpenCode/);
  });

  it('a prompt that never reached the session is reported under GeoCode', () => {
    // Reaching it at runtime takes the whole session service and a kernel that accepts a prompt and then loses it,
    // so this reads the literals the service returns to the geocode tool.
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/openchamber-sessions/routes.js'),
      'utf8',
    );
    const messages = [...source.matchAll(/promptError: '([^'\n]*)'/g)].map((match) => match[1]);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toMatch(/OpenChamber|OpenCode/);
    }
  });
});
