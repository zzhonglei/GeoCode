import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getNormalizedParentDirectory } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';

const FOLDER_WATCH_PATH = '/api/geocode/folder-watch';

/** Well inside the server's lease (LEASE_MS in web/server/geocode/folder-watch.js), after which it forgets a tree. */
const RENEW_MS = 60_000;

const register = (client: string, root: string, directories: readonly string[]): void => {
  void runtimeFetch(FOLDER_WATCH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, root, directories }),
  }).then(
    (response) => {
      if (!response.ok) console.warn('[geocode] the file tree does not follow changes on disk:', response.status);
    },
    (error) => console.warn('[geocode] the file tree does not follow changes on disk:', error),
  );
};

/**
 * The root and each expanded folder whose folders above it are expanded too. A folder inside a collapsed one keeps its
 * expanded mark, but watching it would only re-list the nearest folder on screen whenever it changes.
 */
const foldersOnScreen = (root: string, expanded: readonly string[]): string[] => {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const open = new Set(expanded);
  const onScreen = (folder: string): boolean => {
    if (!folder.startsWith(prefix)) return false;
    for (let parent = getNormalizedParentDirectory(folder); parent && parent !== root; parent = getNormalizedParentDirectory(parent)) {
      if (!open.has(parent)) return false;
    }
    return true;
  };
  return [root, ...new Set(expanded.filter(onScreen))];
};

type Options = {
  root: string;
  /** The folders the tree marks expanded. */
  directories: readonly string[];
  /** The tree is on screen; the server watches nothing for it otherwise. */
  active: boolean;
  /** Folders the tree shows that it should list again. */
  onChanges: (batch: { directories: string[] }) => void;
};

/**
 * Has the shell server watch the folders a file tree shows and tell it which changed on disk, whoever changed them:
 * the agent, QGIS, a terminal, the file manager.
 */
export const useGeoFolderWatch = ({ root, directories, active, onChanges }: Options): void => {
  const onChangesRef = React.useRef(onChanges);
  onChangesRef.current = onChanges;
  // One name per root: leaving one root and registering the next are two requests that may arrive in either order.
  const client = React.useMemo(() => (root ? crypto.randomUUID() : ''), [root]);
  const shown = React.useMemo(() => (root ? foldersOnScreen(root, directories) : []), [root, directories]);
  const shownRef = React.useRef(shown);
  shownRef.current = shown;
  const registeredRef = React.useRef({ client: '', ever: new Set<string>(), now: new Set<string>() });

  // Every change of the folders replaces the tree's registration, so expanding a folder keeps the watch open.
  React.useEffect(() => {
    if (!active || shown.length === 0) return;
    register(client, root, shown);
    const registered = registeredRef.current.client === client
      ? registeredRef.current
      : { client, ever: new Set<string>(), now: new Set<string>() };
    // A folder back on screen was not watched while hidden, and the tree shows what it held then: list it again. One
    // on screen for the first time is being listed by the tree already.
    const back = shown.filter((folder) => !registered.now.has(folder) && registered.ever.has(folder));
    for (const folder of shown) registered.ever.add(folder);
    registered.now = new Set(shown);
    registeredRef.current = registered;
    if (back.length > 0) onChangesRef.current({ directories: back });
  }, [active, client, root, shown]);

  React.useEffect(() => {
    if (!active || !root) return;
    const renew = setInterval(() => register(client, root, shownRef.current), RENEW_MS);
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'folder-changed' && event.client === client) {
        onChangesRef.current({ directories: event.directories });
      }
      // On each connection, the first included: changes sent while the stream was down are lost, and a restarted
      // server has forgotten the tree.
      if (event.type === 'event-stream-ready') {
        register(client, root, shownRef.current);
        onChangesRef.current({ directories: shownRef.current });
      }
    });
    return () => {
      clearInterval(renew);
      unsubscribe();
      register(client, root, []);
    };
  }, [active, client, root]);
};
