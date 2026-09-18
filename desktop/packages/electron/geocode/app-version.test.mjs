/* --- GeoCode: guards a hand-copy left behind by a bump, and a reader quietly falling back to package.json's
 * OpenChamber number (docs/DESKTOP.md §4.6). --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GEOCODE_VERSION } from './app-version.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.resolve(electronRoot, relative), 'utf8');

describe('product version', () => {
  it('is a semantic version that is not the OpenChamber baseline', () => {
    expect(GEOCODE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    const { version: baseline } = JSON.parse(read('package.json'));
    expect(GEOCODE_VERSION).not.toBe(baseline);
  });

  it('is the same number in the web package hand-copy', () => {
    const copy = read('../web/server/geocode/app-version.js').match(/GEOCODE_VERSION = '([^']+)'/)?.[1];
    expect(copy).toBe(GEOCODE_VERSION);
  });

  it('is what main, the renderer build and the installer read', () => {
    expect(read('main.mjs')).toContain('const APP_VERSION = GEOCODE_VERSION;');
    expect(read('../web/vite.config.ts')).toContain('__APP_VERSION__: JSON.stringify(GEOCODE_VERSION)');
    expect(read('scripts/package.mjs')).toContain('--config.extraMetadata.version=${GEOCODE_VERSION}');
  });
});
