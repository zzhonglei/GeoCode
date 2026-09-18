/* --- GeoCode: the copy left beside an overwritten file carries our name, not upstream's
 * (docs/PATHS.md §3.2). The literal is the check, since both writers read the constant. --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_BACKUP_SUFFIX } from './config-backup.js';

const FOREIGN = [/openchamber/i, /opencode/i];

let writeConfig;
let roots;
const saved = {};

beforeAll(async () => {
  // shared.js resolves its config root at import, and this suite never needs the real one.
  roots = ['data', 'config', 'home'].map((kind) =>
    fs.mkdtempSync(path.join(os.tmpdir(), `geocode-config-backup-${kind}-`)));
  for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME']) saved[key] = process.env[key];
  [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME, process.env.HOME] = roots;
  ({ writeConfig } = await import('../lib/opencode/shared.js'));
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('config backup suffix', () => {
  it('names no product but ours', () => {
    expect(CONFIG_BACKUP_SUFFIX).toBe('.geocode.backup');
    for (const pattern of FOREIGN) expect(CONFIG_BACKUP_SUFFIX).not.toMatch(pattern);
  });

  it('is the suffix that reaches the disk, and the only file left beside the config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-config-backup-write-'));
    try {
      const file = path.join(dir, 'geocode.json');
      writeConfig({ model: 'first' }, file);
      writeConfig({ model: 'second' }, file);

      expect(JSON.parse(fs.readFileSync(`${file}${CONFIG_BACKUP_SUFFIX}`, 'utf8')).model).toBe('first');
      expect(fs.readdirSync(dir).sort()).toEqual(['geocode.json', `geocode.json${CONFIG_BACKUP_SUFFIX}`].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
