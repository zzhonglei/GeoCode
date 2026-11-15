import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFolderWatch } from './folder-watch.js';

// Folders in memory, and the watches opened on them: `report` plays the operating system reporting a name.
const makeDisk = (layout, platform = 'darwin') => {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const folders = new Map(Object.entries(layout).map(([folder, names]) => [paths.resolve(folder), [...names]]));
  const reads = [];
  const watches = [];
  const sent = [];
  const watch = createFolderWatch({
    platform,
    broadcast: (event) => sent.push(event.properties),
    readdir: async (folder) => {
      reads.push(folder);
      const names = folders.get(folder);
      if (!names) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return names.map((name) => ({ name, isDirectory: () => false }));
    },
    fsWatch: (root, options, listener) => {
      const watcher = Object.assign(new EventEmitter(), { root, options, closed: false });
      watcher.close = () => { watcher.closed = true; };
      watcher.report = (filename) => listener('rename', filename);
      watches.push(watcher);
      return watcher;
    },
  });
  const set = (folder, names) => folders.set(paths.resolve(folder), names);
  return { watch, watches, sent, reads, set };
};

describe('GeoCode: a folder a window shows is reported when its names change on disk', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Guards against a refresh for every write into a large dataset, and against reading folders no window shows.
  it('reports a change of names, not of contents, and only for folders shown', async () => {
    const disk = makeDisk({ '/p': ['sub'], '/p/sub': ['dem.tif'], '/p/hidden': ['a.tif'] });
    disk.watch.register('w1', '/p', ['/p', '/p/sub']);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.watches).toHaveLength(1);
    expect(disk.watches[0].options.recursive).toBe(true);

    disk.watches[0].report('sub/dem.tif');
    await vi.advanceTimersByTimeAsync(200);
    expect(disk.sent).toEqual([]);

    disk.set('/p/sub', ['dem.tif', 'roads.shp']);
    disk.watches[0].report('sub/roads.shp');
    await vi.advanceTimersByTimeAsync(200);
    expect(disk.sent).toEqual([{ client: 'w1', directories: ['/p/sub'] }]);

    disk.watches[0].report('hidden/a.tif');
    await vi.advanceTimersByTimeAsync(200);
    expect(disk.reads.filter((folder) => folder === '/p/hidden')).toEqual([]);
  });

  // Guards against a tree that stays still until a long unzip ends.
  it('reports a folder at least once a second while events keep coming', async () => {
    const disk = makeDisk({ '/p': [] });
    disk.watch.register('w1', '/p', ['/p']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) {
      disk.set('/p', Array.from({ length: i + 1 }, (_, n) => `tile${n}.tif`));
      disk.watches[0].report(`tile${i}.tif`);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(disk.sent.length).toBeGreaterThanOrEqual(2);
  });

  // Guards Windows: its names use backslashes and any case, and a full buffer reports no name at all.
  it('finds the folder of a Windows name, and checks every folder when the name is lost', async () => {
    const disk = makeDisk({ 'C:\\Proj': ['Data'], 'C:\\Proj\\Data': [] }, 'win32');
    disk.watch.register('w1', 'C:/Proj', ['C:/Proj', 'C:/Proj/Data']);
    await vi.advanceTimersByTimeAsync(0);

    disk.set('C:\\Proj\\Data', ['roads.shp']);
    disk.watches[0].report('data\\ROADS.shp');
    await vi.advanceTimersByTimeAsync(200);
    expect(disk.sent).toEqual([{ client: 'w1', directories: ['C:/Proj/Data'] }]);

    disk.set('C:\\Proj', ['Data', 'new.gpkg']);
    disk.set('C:\\Proj\\Data', ['roads.shp', 'roads.dbf']);
    disk.watches[0].report(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(disk.sent.slice(1)).toEqual(expect.arrayContaining([
      { client: 'w1', directories: ['C:/Proj'] },
      { client: 'w1', directories: ['C:/Proj/Data'] },
    ]));
  });

  // Guards against the endless events Windows sends while the watched root is being deleted.
  it('closes the watch when Windows reports the root itself, and reopens it later', async () => {
    const disk = makeDisk({ 'C:\\Proj': [] }, 'win32');
    disk.watch.register('w1', 'C:/Proj', ['C:/Proj']);
    await vi.advanceTimersByTimeAsync(0);
    disk.watches[0].report('C:\\Proj');
    expect(disk.watches[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disk.watches).toHaveLength(2);
    expect(disk.watches[1].closed).toBe(false);
  });

  // Guards against a watch left open by a window that closed without saying so, and against reopening it on each
  // expanded folder.
  it('keeps one watch while a window renews, and closes it once no window does', async () => {
    const disk = makeDisk({ '/p': ['a'], '/p/a': [] });
    disk.watch.register('w1', '/p', ['/p']);
    await vi.advanceTimersByTimeAsync(0);
    disk.watch.register('w1', '/p', ['/p', '/p/a']);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.watches).toHaveLength(1);
    expect(disk.sent).toEqual([]);

    disk.watch.register('w2', '/p', ['/p']);
    for (let minute = 0; minute < 4; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      disk.watch.register('w1', '/p', ['/p', '/p/a']);
    }
    expect(disk.watches[0].closed).toBe(false);
    disk.watch.register('w1', '/p', []);
    expect(disk.watches[0].closed).toBe(true);
  });

  // Guards against forgetting every window after the computer sleeps: the wall clock jumps, the timers do not.
  it('keeps a window registered across a sleep', async () => {
    const disk = makeDisk({ '/p': [] });
    disk.watch.register('w1', '/p', ['/p']);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disk.watches[0].closed).toBe(false);
  });
});

describe('GeoCode: a folder watch on the real disk', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  // Changes until one is reported: a watch may still be starting, or FSEvents may drop an event, and a lost one is
  // only found by the 30-second safety check.
  const untilReported = async (sent, change) => {
    const end = Date.now() + 10_000;
    for (let attempt = 0; sent.length === 0 && Date.now() < end; attempt++) {
      change(attempt);
      const next = Date.now() + 500;
      while (sent.length === 0 && Date.now() < next) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return sent;
  };

  // Guards what the stand-ins assume: that this platform's watch reports a change below the root under a name that
  // leads to its folder, and a rename of case alone.
  it('reports a file created in a shown folder and a rename of case alone', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-folder-watch-')));
    roots.push(root);
    const sub = path.join(root, 'Data');
    fs.mkdirSync(sub);
    const sent = [];
    const watch = createFolderWatch({ broadcast: (event) => sent.push(event.properties) });
    watch.register('w1', root, [root, sub]);
    try {
      await untilReported(sent, (attempt) => fs.writeFileSync(path.join(sub, `roads${attempt}.shp`), 'a'));
      expect(sent).toContainEqual({ client: 'w1', directories: [sub] });
      expect(sent.filter((event) => event.directories[0] !== sub)).toEqual([]);

      sent.length = 0;
      await untilReported(sent, (attempt) => {
        const [from, to] = attempt % 2 === 0 ? ['roads0.shp', 'Roads0.shp'] : ['Roads0.shp', 'roads0.shp'];
        fs.renameSync(path.join(sub, from), path.join(sub, to));
      });
      expect(sent).toContainEqual({ client: 'w1', directories: [sub] });
    } finally {
      watch.register('w1', root, []);
    }
  });
});
