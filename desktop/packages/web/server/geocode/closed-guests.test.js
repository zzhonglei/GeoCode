import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findInstalledGuest, listInstalledGuests } from '../lib/guests/catalog.js';
import { writeExtensionPaths } from '../lib/guests/persist.js';

// Guards against an installed extension still being found, and so run, inside the desktop app.
describe('GeoCode: listInstalledGuests', () => {
  const originalElectron = process.versions.electron;
  let dir;

  afterAll(async () => {
    if (originalElectron === undefined) delete process.versions.electron;
    else process.versions.electron = originalElectron;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('hides an installed extension only inside the desktop app', async () => {
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

    delete process.versions.electron;
    expect((await listInstalledGuests({ persistPath })).map((guest) => guest.id)).toEqual(['hello']);

    process.versions.electron = 'test';
    expect(await listInstalledGuests({ persistPath })).toEqual([]);
    expect(await findInstalledGuest('hello', persistPath)).toBeNull();
  });
});
