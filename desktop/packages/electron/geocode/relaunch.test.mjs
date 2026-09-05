/* --- GeoCode: a relaunch comes back in a development launch too (geocode/relaunch.mjs).
 *
 * The option builder is pinned directly; main.mjs is pinned by source so that no relaunch
 * call is left with the default arguments, which is the form that fails. --- */
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
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toContain('relaunchOptions({ packaged: app.isPackaged, argv: process.argv, entryFile: __filename })');
    }
  });
});
