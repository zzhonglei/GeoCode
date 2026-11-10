import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { createSessionActivityProbe } from '../lib/opencode/session-activity.js';

const rivers = path.resolve('/projects/rivers');
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// A kernel with one command and two Earth Engine runs in the background, one of them in another folder.
const kernel = async (url) => {
  if (String(url).includes('/api/shell')) {
    return json([{ status: 'running', command: 'make', time: { started: 1 }, metadata: { sessionID: 'ses_shell' } }]);
  }
  if (String(url).includes('/api/rpc/geocode.geeruns/list')) {
    return json({
      output: {
        revision: 3,
        runs: [
          { id: 'a', sessionID: 'ses_gee', description: 'NDVI composite', startedAt: 2, directory: rivers },
          { id: 'b', sessionID: 'ses_other', description: 'Land cover', startedAt: 3, directory: path.resolve('/projects/roads') },
        ],
      },
    });
  }
  return new Response('', { status: 404 });
};

// Guards against goals and scheduled tasks no longer waiting on an Earth Engine run in the background, which the
// kernel's shell list does not hold.
describe('GeoCode: background Earth Engine runs', () => {
  it('count as commands running in their folder', async () => {
    const probe = createSessionActivityProbe({ buildOpenCodeUrl: (route) => `http://kernel${route}`, getOpenCodeAuthHeaders: () => ({}), fetchImpl: kernel });
    const running = await probe.fetchRunningShells(rivers);
    expect(running?.map((entry) => entry.sessionID)).toEqual(['ses_shell', 'ses_gee']);
  });
});
