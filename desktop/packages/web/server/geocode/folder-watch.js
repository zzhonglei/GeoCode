import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { z } from 'zod';

/** What a window hears when a folder it shows changed on disk; ui/src/geocode/files/folderChanged.test.ts holds the window's copy to it. */
export const FOLDER_CHANGED_EVENT = 'geocode:folder-changed';

// A folder is checked this long after its last event, and at least once a second while events keep coming (an unzip).
const SETTLE_MS = 100;
const MAX_WAIT_MS = 1000;
// Every shown folder is checked again this often, and a watch that failed reopens: FSEvents drops events without a
// signal, and its shared stream loses them while another watch in the process opens or closes.
const SAFETY_MS = 30_000;
// A window renews its folders every minute (RENEW_MS in ui/src/geocode/files/useGeoFolderWatch.ts); one that stopped
// renewing (closed, crashed) is forgotten after this.
const LEASE_MS = 3 * 60_000;

const registrationSchema = z.object({
  client: z.string().min(1).max(100),
  root: z.string().min(1),
  directories: z.array(z.string()),
});

/**
 * Watches the project folders windows show, one recursive watch per root: on Windows a watch holds its folder open,
 * which keeps every folder above it from being renamed or moved, and a watch of a single folder goes quiet once the
 * folder is renamed. An event only says a folder may have changed: on macOS a change of contents can arrive as a
 * rename, and on Windows reading a file is an event. So a folder is reported only when its names differ from the last
 * check.
 */
export const createFolderWatch = ({
  broadcast,
  platform = process.platform,
  fsWatch = fs.watch,
  readdir = fs.promises.readdir,
  timers = globalThis,
  now = Date.now,
}) => {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  // Windows paths ignore case. Names inside a folder are compared as they are, so a rename of case alone shows.
  const keyOf = (location) => (platform === 'win32' ? location.toLowerCase() : location);
  /** client -> { root, directories: folder key -> the path as that window spells it, expires } */
  const clients = new Map();
  /** root key -> { path, watcher, folders: folder key -> { path, names, version, settle, deadline } } */
  const roots = new Map();
  let safety = null;
  let lastSweep = 0;

  const notify = (root, key) => {
    for (const [client, entry] of clients) {
      const spelling = entry.root === root ? entry.directories.get(key) : undefined;
      if (spelling !== undefined) broadcast({ type: FOLDER_CHANGED_EVENT, properties: { client, directories: [spelling] } });
    }
  };

  const check = async (root, key, folder) => {
    timers.clearTimeout(folder.settle);
    folder.settle = null;
    folder.deadline = 0;
    folder.version += 1;
    const version = folder.version;
    const names = await readdir(folder.path, { withFileTypes: true }).then(
      (entries) => entries.map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort().join('\0'),
      (error) => `!${error.code}`,
    );
    // A later check, or the folder no longer shown, has the last word.
    if (version !== folder.version || root.folders.get(key) !== folder) return;
    const previous = folder.names;
    folder.names = names;
    if (previous !== undefined && previous !== names) notify(root, key);
  };

  const mark = (root, key, folder) => {
    const at = now();
    if (!folder.deadline) folder.deadline = at + MAX_WAIT_MS;
    timers.clearTimeout(folder.settle);
    folder.settle = timers.setTimeout(() => void check(root, key, folder), Math.min(SETTLE_MS, folder.deadline - at));
  };

  const markAll = (root) => {
    for (const [key, folder] of root.folders) mark(root, key, folder);
  };

  const unwatch = (root) => {
    root.watcher?.close();
    root.watcher = null;
  };

  const onEvent = (root, filename) => {
    // No name: Windows dropped events from a full buffer. A full path: the root itself is being deleted, which Windows
    // reports over and over, so the watch closes until the safety check finds the folder back.
    if (!filename || paths.isAbsolute(filename)) {
      if (filename) unwatch(root);
      markAll(root);
      return;
    }
    const key = keyOf(paths.dirname(paths.join(root.path, filename)));
    const folder = root.folders.get(key);
    if (folder) mark(root, key, folder);
  };

  const watch = (root) => {
    try {
      const watcher = fsWatch(root.path, { recursive: true, persistent: false }, (_type, filename) => onEvent(root, filename));
      watcher.on('error', () => {
        if (root.watcher !== watcher) return;
        unwatch(root);
        markAll(root);
      });
      root.watcher = watcher;
    } catch {
      // A root that is missing or cannot be watched waits for the safety check.
    }
  };

  const sweep = () => {
    const at = now();
    // A sweep far behind its interval follows a sleep, which the windows' renewals have not caught up with yet: every
    // lease would look lapsed, so all are renewed instead.
    const slept = at - lastSweep > 2 * SAFETY_MS;
    lastSweep = at;
    for (const [client, entry] of clients) {
      if (slept) entry.expires = at + LEASE_MS;
      else if (entry.expires < at) clients.delete(client);
    }
    prune();
    for (const root of roots.values()) {
      if (!root.watcher) watch(root);
      for (const [key, folder] of root.folders) void check(root, key, folder);
    }
  };

  // Drops the folders no window shows and the roots no window has, and runs the safety check while any is left.
  const prune = () => {
    for (const [rootKey, root] of roots) {
      const shown = new Set();
      for (const entry of clients.values()) {
        if (entry.root === root) for (const key of entry.directories.keys()) shown.add(key);
      }
      for (const [key, folder] of root.folders) {
        if (shown.has(key)) continue;
        timers.clearTimeout(folder.settle);
        root.folders.delete(key);
      }
      if (root.folders.size > 0) continue;
      unwatch(root);
      roots.delete(rootKey);
    }
    if (roots.size === 0 && safety) {
      timers.clearInterval(safety);
      safety = null;
    }
    if (roots.size > 0 && !safety) {
      lastSweep = now();
      safety = timers.setInterval(sweep, SAFETY_MS);
      safety.unref?.();
    }
  };

  /** Replaces what `client` shows: folders under `rootPath`, none to stop. */
  const register = (client, rootPath, directories) => {
    clients.delete(client);
    if (directories.length > 0 && paths.isAbsolute(rootPath)) {
      const resolvedRoot = paths.resolve(rootPath);
      const rootKey = keyOf(resolvedRoot);
      const root = roots.get(rootKey) ?? { path: resolvedRoot, watcher: null, folders: new Map() };
      const shown = new Map();
      for (const directory of directories) {
        const resolved = paths.resolve(directory);
        const key = keyOf(resolved);
        shown.set(key, directory);
        if (root.folders.has(key)) continue;
        const folder = { path: resolved, names: undefined, version: 0, settle: null, deadline: 0 };
        root.folders.set(key, folder);
        void check(root, key, folder);
      }
      clients.set(client, { root, directories: shown, expires: now() + LEASE_MS });
      if (!roots.has(rootKey)) {
        roots.set(rootKey, root);
        watch(root);
      }
    }
    prune();
  };

  return { register };
};

export const registerFolderWatch = (app, { broadcast }) => {
  const folderWatch = createFolderWatch({ broadcast });
  app.post('/api/geocode/folder-watch', express.json({ limit: '1mb' }), (req, res) => {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A folder watch needs a client, a root and the folders it shows.' });
      return;
    }
    folderWatch.register(parsed.data.client, parsed.data.root, parsed.data.directories);
    res.status(204).end();
  });
};
