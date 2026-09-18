/* --- GeoCode: closing the Linear routes does not reach this one, which posts issue comments straight off the
 * session event bus rather than through a request, so the shell stops it too (docs/DESKTOP.md §7.3). --- */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const posted = vi.hoisted(() => []);
vi.mock('../lib/linear/status.js', () => ({
  postLinearSessionStatus: async (input) => {
    posted.push(input);
    return null;
  },
}));

import { createLinearSessionStatusRuntime } from '../lib/linear/status-runtime.js';

const idle = {
  type: 'session.status',
  properties: { info: { sessionID: 'ses_probe' }, status: { type: 'idle' } },
};
const failed = {
  type: 'session.error',
  properties: { info: { sessionID: 'ses_probe' }, error: { name: 'Boom' } },
};

describe('the Linear session-status runtime', () => {
  it('control: a running one comments on a settled session, which is what has to stop', () => {
    posted.length = 0;
    createLinearSessionStatusRuntime().processPayload(idle);
    expect(posted).toEqual([{ kind: 'completed', sessionId: 'ses_probe' }]);
  });

  it('a stopped one says nothing, however many events arrive', () => {
    posted.length = 0;
    const runtime = createLinearSessionStatusRuntime();
    runtime.stop();
    runtime.processPayload(idle);
    runtime.processPayload(failed);
    expect(posted).toEqual([]);
  });

  it('the shell stops it under Electron, where the routes answer 404', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
    const created = source.indexOf('const linearSessionStatusRuntime = createLinearSessionStatusRuntime();');
    const stopped = source.indexOf('if (process.versions.electron) linearSessionStatusRuntime.stop();');
    expect(created).toBeGreaterThan(-1);
    expect(stopped).toBeGreaterThan(created);
  });
});
