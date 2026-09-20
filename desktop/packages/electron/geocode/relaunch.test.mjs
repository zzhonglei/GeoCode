/* --- GeoCode: guards a development relaunch that looks for its relative entry in the home directory
 * (geocode/relaunch.mjs). --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { relaunchOptions } from './relaunch.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');

describe('relaunch options', () => {
  it('replaces a relative entry with the absolute one and keeps the rest', () => {
    expect(relaunchOptions({ packaged: false, argv: ['/bin/electron', './main.mjs', '--background'], entryFile: '/app/main.mjs' }))
      .toEqual({ args: ['/app/main.mjs', '--background'] });
  });

  it('leaves packaged builds and absolute entries alone', () => {
    expect(relaunchOptions({ packaged: true, argv: ['/bin/electron', './main.mjs'], entryFile: '/app/main.mjs' })).toBeUndefined();
    expect(relaunchOptions({ packaged: false, argv: ['/bin/electron', '/app/main.mjs'], entryFile: '/app/main.mjs' })).toBeUndefined();
    expect(relaunchOptions({ packaged: false, argv: ['/Applications/GeoCode.app/Contents/MacOS/GeoCode'], entryFile: '/app/main.mjs' })).toBeUndefined();
  });

  it('every relaunch in main.mjs passes the options', () => {
    const calls = mainSource.match(/app\.relaunch\([^\n]*\)/g) ?? [];
    // A floor against the pattern silently matching nothing, not a pinned count.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toContain('relaunchOptions({ packaged: app.isPackaged, argv: process.argv, entryFile: __filename })');
    }
  });
});
