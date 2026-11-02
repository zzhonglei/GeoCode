import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materializeSessionTitlePlugin } from '../lib/opencode/session-title-plugin.js';

const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-session-title-'));
afterAll(() => fs.rmSync(instanceDir, { recursive: true, force: true }));

// Guards against the plugin that names sessions, which the managed config always loads, carrying upstream's name
// into the kernel's plugin list.
describe('GeoCode: the session title plugin', () => {
  it('is named GeoCode', async () => {
    const directory = await materializeSessionTitlePlugin({ fsPromises: fs.promises, path, instanceDir });
    expect(path.basename(directory)).toBe('geocode-session-title');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name).toBe('geocode-session-title');
  });
});
