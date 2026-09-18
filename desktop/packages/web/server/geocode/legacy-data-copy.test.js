/* --- GeoCode: nothing is copied at startup out of an OpenChamber directory, whose project files hold shell
 * commands bound to buttons (docs/PATHS.md §3.3). --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyUserDirs } from '../lib/data-dir-migration.js';

const seed = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-legacy-copy-'));
  const legacyRoot = path.join(base, 'openchamber');
  const dataDir = path.join(base, 'GeoCode', 'desktop');
  fs.mkdirSync(path.join(legacyRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'projects', 'path_x.json'), '{"projectActions":[]}');
  fs.mkdirSync(path.join(legacyRoot, 'themes'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'themes', 'theme.json'), '{}');
  return { base, legacyRoot, dataDir };
};

describe('legacy data copy', () => {
  it('leaves the folders of the other product where they are', async () => {
    const { base, legacyRoot, dataDir } = seed();
    try {
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('control: the upstream body it shields does copy them', async () => {
    const { base, legacyRoot, dataDir } = seed();
    try {
      // A reduced copy of the shielded upstream loop, run on the same seed.
      const moved = [];
      for (const entry of ['projects', 'themes']) {
        const from = path.join(legacyRoot, entry);
        const to = path.join(dataDir, entry);
        await fsPromises.mkdir(dataDir, { recursive: true });
        await fsPromises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        moved.push(entry);
      }
      expect(moved).toEqual(['projects', 'themes']);
      expect(fs.existsSync(path.join(dataDir, 'projects', 'path_x.json'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
