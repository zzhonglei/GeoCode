import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { applyShellDataRoot, resolveShellDataRoot } from './shell-data-root.mjs';
// The renderer's copy of the root, imported across the package boundary to pin the two together.
import { CHATS_SEGMENTS, SHELL_DATA_ROOT_SEGMENTS } from '../../ui/src/geocode/shell-data-root.ts';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOME = path.join('/tmp', 'geocode-home');

describe('shell data root', () => {
  it('overwrites an inherited value instead of honouring it', () => {
    // An inherited value belongs to a user's own OpenChamber.
    const environment = { OPENCHAMBER_DATA_DIR: '/somewhere/openchamber' };
    applyShellDataRoot({ environment, homeDirectory: HOME });
    expect(environment.OPENCHAMBER_DATA_DIR).toBe(resolveShellDataRoot(HOME));
  });

  it('points the managed process registry at its own variable', () => {
    // The registry's fallback does not read OPENCHAMBER_DATA_DIR.
    const environment = {};
    applyShellDataRoot({ environment, homeDirectory: HOME });
    expect(environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY)
      .toBe(path.join(resolveShellDataRoot(HOME), 'managed-opencode'));
  });

  it('lands the renderer on the same root, including its children', () => {
    // The renderer rebuilds this root from HOME as its fallback chats root and counts directories under it as
    // chats (ui/src/lib/chatDirectories.ts), so the two must stay equal.
    expect(resolveShellDataRoot(HOME)).toBe(path.join(HOME, ...SHELL_DATA_ROOT_SEGMENTS));
    expect(path.join(HOME, ...CHATS_SEGMENTS)).toBe(path.join(resolveShellDataRoot(HOME), 'chats'));
  });

  it('keeps shell data out of the config root the kernel owns', () => {
    expect(resolveShellDataRoot(HOME)).toBe(path.join(HOME, '.config', 'GeoCode', 'desktop'));
  });

  it('stays wired into main.mjs ahead of the first reader of a settings path', () => {
    // `sshManager` resolves a settings path at module top level and keeps the string.
    const main = fs.readFileSync(
      new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const injectedAt = main.indexOf('applyShellDataRoot({');
    const firstReaderAt = main.indexOf('new ElectronSshManager(');
    expect(injectedAt).toBeGreaterThan(-1);
    expect(firstReaderAt).toBeGreaterThan(injectedAt);
  });

  it('is the only place in the package that spells the root out', () => {
    // `main.mjs` used to repeat the segments for its settings fallback, which is a copy that drifts the
    // moment the root moves. Scanned rather than listed: a new copy in a file nobody listed is the case
    // the listing cannot see.
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const SKIP = new Set(['node_modules', 'resources', 'dist', '.turbo']);
    const SPELLED = /'\.config',\s*'GeoCode'|"\.config",\s*"GeoCode"|\.config\/GeoCode\/desktop/;
    const OWN = new Set([fileURLToPath(new URL('./shell-data-root.mjs', import.meta.url)), fileURLToPath(import.meta.url)]);
    const offenders = [];
    // Walked by hand rather than with a recursive readdir: that one descends into node_modules before any
    // filter can see it, which does not finish.
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(mjs|js|cjs)$/.test(entry.name) || OWN.has(full)) continue;
        if (SPELLED.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(packageRoot, full));
      }
    };
    walk(packageRoot);
    expect(offenders).toEqual([]);
  });

  it('refuses to guess when the home directory is missing', () => {
    for (const bad of [undefined, '', null, 42]) {
      expect(() => applyShellDataRoot({ environment: {}, homeDirectory: bad })).toThrow();
    }
  });
});
