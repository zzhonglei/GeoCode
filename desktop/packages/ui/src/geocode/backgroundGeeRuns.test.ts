import { beforeEach, describe, expect, test } from 'bun:test';

import { routeWireEvent } from '@/lib/opencode/events';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import {
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  replaceGlobalSessionStatusById,
} from '@/sync/global-session-status';
import { resetSessionActivityTiming, useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { createEventRoutingIndex, handleEvent } from '@/sync/sync-context';

import { applyGeeRuns, hasRunningGeeRun, resetGeeRuns } from './backgroundGeeRuns';

const run = { id: 'job_1', sessionID: 'ses_1', description: '计算台北 2025 年 NDVI', startedAt: 1000 };
const listed = (revision: number, running: boolean) => ({ revision, runs: running ? [run] : [] });
const timed = () => useSessionActivityTimingStore.getState().startedAt.has('ses_1');
const busy = () =>
  applyGlobalSessionStatusEvents('/repo', [
    { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
  ]);
const idle = () => {
  applyGlobalSessionStatusEvents('/repo', [{ type: 'session.idle', properties: { sessionID: 'ses_1' } }]);
  applyGlobalSessionStatusSnapshot('/repo', {}, ['ses_1']);
};

beforeEach(() => {
  resetGeeRuns();
  replaceGlobalSessionStatusById(new Map());
  resetSessionActivityTiming();
});

describe('GeoCode: Earth Engine runs in the background', () => {
  // Guards against the kernel's list reaching the stream but not the interface.
  test("the kernel's event lists the run, and a later one takes it off", () => {
    const childStores = new ChildStoreManager();
    const receive = (revision: number, running: boolean) => {
      const routed = routeWireEvent({
        id: `evt_${revision}`,
        created: 1000,
        location: { directory: '/repo' },
        type: 'rpc.geocode.geeruns.changed',
        data: listed(revision, running),
      });
      for (const { directory, event } of routed) {
        handleEvent(directory, event, childStores, createEventRoutingIndex(), getRuntimeKey());
      }
    };
    receive(1, true);
    expect(hasRunningGeeRun('ses_1')).toBe(true);
    receive(2, false);
    expect(hasRunningGeeRun('ses_1')).toBe(false);
    childStores.disposeAll();
  });

  // Guards against the turn timer stopping while the run goes on in the background, or going on after it.
  test("keeps the session's turn timed while its run goes on after the turn, as a command does", () => {
    busy();
    applyGeeRuns(listed(1, true));
    idle();
    expect(timed()).toBe(true);
    applyGeeRuns(listed(2, false));
    expect(timed()).toBe(false);
  });
});
