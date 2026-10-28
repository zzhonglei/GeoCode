import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { useGeoCodeDataDir } from './data-dir.mjs';

const ELECTRON = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMPORT = /^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
const imported = (file) => [...fs.readFileSync(file, 'utf8').matchAll(IMPORT)].map((found) => found[1] ?? found[2]);
const resolved = (from, specifier) =>
  specifier.startsWith('node:') || specifier === 'electron' || builtinModules.includes(specifier)
    ? null
    : createRequire(from).resolve(specifier);

/** The modules evaluated before early-startup.mjs's own lines run: entry.mjs's imports, and early-startup's. */
const loadedFirst = () => {
  const seen = new Set();
  const visit = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    for (const specifier of imported(file)) visit(resolved(file, specifier));
  };
  const entry = path.join(ELECTRON, 'entry.mjs');
  for (const specifier of imported(entry)) {
    const file = resolved(entry, specifier);
    if (file?.endsWith(`${path.sep}early-startup.mjs`)) {
      for (const inner of imported(file)) visit(resolved(file, inner));
    } else visit(file);
  }
  return [...seen];
};

// Upstream modules take the data directory when they load, falling back to OpenChamber's ~/.config/openchamber.
test('the shell keeps its data under GeoCode’s data directory, set before any upstream module loads', () => {
  const environment = {};
  useGeoCodeDataDir(environment);
  assert.equal(environment.OPENCHAMBER_DATA_DIR, path.join(os.homedir(), '.local', 'share', 'geocode', 'desktop'));
  assert.ok(environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY.startsWith(environment.OPENCHAMBER_DATA_DIR + path.sep));

  const upstream = loadedFirst().filter((file) => !file.split(path.sep).includes('geocode'));
  assert.ok(upstream.some((file) => file.endsWith('shell-environment.mjs')), 'the walk follows the imports');
  const reading = upstream.filter((file) =>
    /OPENCHAMBER_DATA_DIR|OPENCHAMBER_MANAGED_PROCESS_REGISTRY|['"]openchamber['"]\s*\)/.test(fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(reading, []);

  // In early-startup.mjs itself, before any line of its own but the one that clears inherited variables.
  const lines = fs
    .readFileSync(path.join(ELECTRON, 'early-startup.mjs'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !/^\s*(import\b|\/\/|\/?\*)/.test(line) && !/^\s*}\s*from\s/.test(line));
  assert.match(lines[0], /^dropInheritedAppVariables\(process\.env\);/);
  assert.match(lines[1], /^useGeoCodeDataDir\(process\.env\);/);
});
