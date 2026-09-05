#!/usr/bin/env node
// Bumps GeoCode's product version in both hand-copies (docs/DESKTOP.md §4.6). Upstream's
// package.json versions are left alone: they say which OpenChamber the shell is based on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  'desktop/packages/electron/geocode/app-version.mjs',
  'desktop/packages/web/server/geocode/app-version.js',
];
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error('usage: node scripts/bump-geocode-version.mjs <version>   e.g. 1.0.1 or 1.1.0-beta.1');
  process.exit(1);
}
for (const relative of copies) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, 'utf8');
  const updated = source.replace(/export const GEOCODE_VERSION = '[^']+';/, `export const GEOCODE_VERSION = '${next}';`);
  if (updated === source) {
    console.error(`no version line found in ${relative}`);
    process.exit(1);
  }
  fs.writeFileSync(file, updated);
  console.log(`${relative}: ${next}`);
}
