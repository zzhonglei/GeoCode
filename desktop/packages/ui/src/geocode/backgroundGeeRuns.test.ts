import { beforeEach, describe, expect, test } from 'bun:test';

import { readWorktreeUse } from '@/components/overview/overviewActions';
import { opencodeClient } from '@/lib/opencode/client';
import { routeWireEvent } from '@/lib/opencode/events';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import {
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  replaceGlobalSessionStatusById,
} from '@/sync/global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { resetSessionActivityTiming, useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { createEventRoutingIndex, handleEvent } from '@/sync/sync-context';

import { applyGeeRuns, hasRunningGeeRun, resetGeeRuns } from './backgroundGeeRuns';

const worktree = '/repo/worktrees/roads';
const run = { id: 'job_1', sessionID: 'ses_1', description: '计算台北 2025 年 NDVI', startedAt: 1000, directory: worktree };
const listed = (revision: number, running: boolean) => ({ revision, runs: running ? [run] : [] });
const timed = () => useSessionActivityTimingStore.getState().startedAt.has('ses_1');
const busy = () =>
  applyGlobalSessionStatusEvents('/repo', [
    { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' }, turnStart: { at: 1000, source: 'live' } } },
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

  // Guards against archiving a worktree, and with it the run's folder and session, while the run goes on there.
  test('keeps the worktree of a session whose run goes on in the background in use', async () => {
    // SAFETY: readWorktreeUse reads a session's id and directory alone.
    useGlobalSessionsStore.setState({ activeSessions: [{ id: 'ses_1', directory: worktree } as Session] });
    const statuses = opencodeClient.getActiveSessionStatuses;
    opencodeClient.getActiveSessionStatuses = async () => ({});
    try {
      applyGeeRuns(listed(1, true));
      expect(await readWorktreeUse(worktree)).toBe('busy');
    } finally {
      opencodeClient.getActiveSessionStatuses = statuses;
      useGlobalSessionsStore.setState({ activeSessions: [] });
    }
  });

  // Guards against a run found through the active sessions alone: archiving its session takes the session out of
  // them while the run goes on, and a background command's worktree is kept by where it runs.
  test('keeps the worktree in use by where the run goes on, after its session is archived', async () => {
    const statuses = opencodeClient.getActiveSessionStatuses;
    opencodeClient.getActiveSessionStatuses = async () => ({});
    try {
      applyGeeRuns(listed(1, true));
      expect(await readWorktreeUse(worktree)).toBe('busy');
      expect(await readWorktreeUse('/repo/worktrees/rivers')).toBe('free');
    } finally {
      opencodeClient.getActiveSessionStatuses = statuses;
    }
  });
});
