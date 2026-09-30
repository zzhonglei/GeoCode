import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findInstalledGuest, listInstalledGuests } from '../lib/guests/catalog.js';
import { readExtensionStore, writeExtensionPaths } from '../lib/guests/persist.js';

// Guards against an installed extension still being found, and so run.
describe('GeoCode: listInstalledGuests', () => {
  let dir;

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds no installed extension', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-guest-'));
    const persistPath = path.join(dir, 'extensions.json');
    const guestRoot = path.join(dir, 'hello');
    await fs.mkdir(path.join(guestRoot, 'panel'), { recursive: true });
    await fs.writeFile(path.join(guestRoot, 'panel', 'index.html'), '<html></html>');
    await fs.writeFile(path.join(guestRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/hello',
      openchamber: { apiVersion: 1, contributes: { panel: { id: 'hello', name: 'Hello', icon: 'window', entry: 'panel/index.html' } } },
    }));
    await writeExtensionPaths([guestRoot], persistPath);
    expect((await readExtensionStore(persistPath)).paths).toEqual([guestRoot]);

    expect(await listInstalledGuests({ persistPath })).toEqual([]);
    expect(await findInstalledGuest('hello', persistPath)).toBeNull();
  });
});
