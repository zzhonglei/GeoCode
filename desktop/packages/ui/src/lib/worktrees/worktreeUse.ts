import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useBackgroundGeeRuns } from '@/geocode/backgroundGeeRuns'; // GeoCode: see readWorktreeUse
import { useSessionUIStore } from '@/sync/session-ui-store';

const isInside = (directory: string | null | undefined, root: string): boolean => {
  const normalized = normalizePath(directory ?? null);
  return normalized === root || Boolean(normalized?.startsWith(`${root}/`));
};

/** Sessions working in the worktree, its subdirectories and subsessions included. */
export const sessionsInWorktree = (sessions: readonly Session[], path: string): Session[] => {
  const root = normalizePath(path);
  return root ? sessions.filter((session) => isInside(resolveGlobalSessionDirectory(session), root)) : [];
};

export type WorktreeUse = 'free' | 'busy' | 'inUse' | 'unknown';

/**
 * Whether anything works in the worktree right now, read at the moment of the
 * action. On screen: the directory shown or the open session is there. Busy: a
 * background command runs there, or the host reports a session there running;
 * a failed read is unknown, never free. The host is asked directly because the
 * per-directory status cache is evicted for directories nobody looked at for a
 * while, and a worktree waiting for cleanup is exactly such a directory.
 */
export async function readWorktreeUse(path: string): Promise<WorktreeUse> {
  const root = normalizePath(path) ?? path;
  // Ask the host first and read local state after it answers, so a session
  // opened or started meanwhile counts.
  const statuses = await opencodeClient.getActiveSessionStatuses(root);
  const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, root);
  const currentSessionId = useSessionUIStore.getState().currentSessionId;
  if (isInside(useDirectoryStore.getState().currentDirectory, root) || sessions.some((session) => session.id === currentSessionId)) return 'inUse';
  const shells = useBackgroundShellsStore.getState();
  if ([...shells.byId.values()].some((shell) => isInside(shell.directory, root)) || sessions.some((session) => shells.sessionIds.has(session.id))) {
    return 'busy';
  }
  const gee = useBackgroundGeeRuns.getState(); // GeoCode: an Earth Engine run in the background keeps its worktree busy, by a background command's two rules
  if (gee.runs.some((run) => isInside(run.directory, root)) || sessions.some((session) => gee.sessionIds.has(session.id))) return 'busy'; // GeoCode: see the line above
  // One read of the host's map covers every directory; a session missing from it is idle.
  if (!statuses) return 'unknown';
  return sessions.some((session) => session.id in statuses) ? 'busy' : 'free';
}
