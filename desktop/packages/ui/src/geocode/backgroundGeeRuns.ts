import React from 'react';
import { create } from 'zustand';

import { applySessionActivityTimingMutations } from '@/sync/session-activity-timing';

import type { GeeRunsSnapshot } from './geeRunsRpc';

export type BackgroundGeeRun = GeeRunsSnapshot['runs'][number];

/**
 * The Earth Engine runs under way in the background, as the kernel's lists and events tell of them, and the sessions
 * they belong to: the same set while those sessions stay the same, so what follows only the sessions does not rerender.
 * The interface treats them as it treats background shell commands: every place that consults
 * `@/sync/background-shells` consults this too, by the same rule, but for the hooks serving extensions.
 */
export const useBackgroundGeeRuns = create<{ runs: readonly BackgroundGeeRun[]; sessionIds: ReadonlySet<string> }>(
  () => ({ runs: [], sessionIds: new Set() }),
);

/** The revision of the list last applied: a list read before an event that came after it is older. */
let revision = 0;
/** Moved on when the runtime changes, so a list the previous one answers late is dropped. */
let generation = 0;

export const applyGeeRuns = (snapshot: GeeRunsSnapshot): void => {
  if (snapshot.revision <= revision) return;
  revision = snapshot.revision;
  const previous = useBackgroundGeeRuns.getState().sessionIds;
  const next = new Set(snapshot.runs.map((run) => run.sessionID));
  const same = next.size === previous.size && [...next].every((id) => previous.has(id));
  useBackgroundGeeRuns.setState({ runs: snapshot.runs, sessionIds: same ? previous : next });
};

/** Reads the list, for when the interface may have missed its events: as it starts, and after a reconnect. */
export const refreshGeeRuns = async (list: () => Promise<GeeRunsSnapshot>): Promise<void> => {
  const started = generation;
  const snapshot = await list();
  if (started === generation) applyGeeRuns(snapshot);
};

export const resetGeeRuns = (): void => {
  generation += 1;
  revision = 0;
  useBackgroundGeeRuns.setState({ runs: [], sessionIds: new Set() });
};

export const hasRunningGeeRun = (sessionId: string): boolean => useBackgroundGeeRuns.getState().sessionIds.has(sessionId);

/** Whether any of the sessions has a run in the background, as a collapsed group of them asks of a command. */
export const useAnyGeeRun = (enabled: boolean, sessionIds: ReadonlySet<string>): boolean =>
  useBackgroundGeeRuns(
    React.useCallback(
      (state) => enabled && [...sessionIds].some((sessionId) => state.sessionIds.has(sessionId)),
      [enabled, sessionIds],
    ),
  );

/**
 * As the last background command of an idle session ending closes its turn: the last run in the background ending
 * does, unless `busy` says the session has other work.
 */
export const settleEndedGeeRuns = (busy: (sessionId: string) => boolean): void => {
  useBackgroundGeeRuns.subscribe((state, previous) => {
    if (state.sessionIds === previous.sessionIds) return;
    applySessionActivityTimingMutations(
      [...previous.sessionIds]
        .filter((sessionId) => !state.sessionIds.has(sessionId) && !busy(sessionId))
        .map((sessionId) => ({ type: 'observe' as const, sessionId, phase: 'settled' as const })),
    );
  });
};
