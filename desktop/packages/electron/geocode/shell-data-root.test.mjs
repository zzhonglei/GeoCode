import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { applyShellDataRoot, resolveShellDataRoot } from './shell-data-root.mjs';
// The renderer's copy of the same root. Imported across the package boundary on purpose —
// see 'the renderer lands on the same root' below.
import { CHATS_SEGMENTS, PROJECTS_SEGMENTS, SHELL_DATA_ROOT_SEGMENTS } from '../../ui/src/geocode/shell-data-root.ts';

import fs from 'node:fs';

const HOME = path.join('/tmp', 'geocode-home');

describe('shell data root', () => {
  it('overwrites an inherited value instead of honouring it', () => {
    // A user running OpenChamber has this exported in the shell we inherit. Honouring it
    // would put GeoCode's settings and sessions inside their OpenChamber directory.
    const environment = { OPENCHAMBER_DATA_DIR: '/somewhere/openchamber' };
    applyShellDataRoot({ environment, homeDirectory: HOME });
    expect(environment.OPENCHAMBER_DATA_DIR).toBe(resolveShellDataRoot(HOME));
  });

  it('points the managed process registry at its own variable', () => {
    // The registry's fallback is hardcoded rather than derived from the data root, so setting
    // only the root would leave it writing to the old location.
    const environment = {};
    applyShellDataRoot({ environment, homeDirectory: HOME });
    expect(environment.OPENCHAMBER_MANAGED_PROCESS_REGISTRY)
      .toBe(path.join(resolveShellDataRoot(HOME), 'managed-opencode'));
  });

  it('lands the renderer on the same root, including its children', () => {
    // THE assertion this file exists for, and the only place in the tree that makes it.
    // Every server-side reader is TOLD this root through the variable set above; the renderer
    // cannot be told — it has no environment — so it rebuilds the path from the home directory
    // and the two are equal only by agreement. When that agreement broke, GeoCode created its
    // chats inside OpenChamber's directory while the server looked for them under an Electron
    // userData path, and `managedProjectRoots` — which decides whose memory a chat session
    // writes to — matched nothing (docs/PATHS.md §5).
    expect(resolveShellDataRoot(HOME)).toBe(path.join(HOME, ...SHELL_DATA_ROOT_SEGMENTS));
    expect(path.join(HOME, ...CHATS_SEGMENTS)).toBe(path.join(resolveShellDataRoot(HOME), 'chats'));
    expect(path.join(HOME, ...PROJECTS_SEGMENTS)).toBe(path.join(resolveShellDataRoot(HOME), 'projects'));
  });

  it('keeps shell data out of the config root the kernel owns', () => {
    // `.config/GeoCode` is where the KERNEL keeps agents, skills and auth. macOS folds
    // `geocode` into `GeoCode`, so without a segment of its own the shell's settings and
    // chats would land among the agent's configuration.
    expect(resolveShellDataRoot(HOME)).toBe(path.join(HOME, '.config', 'GeoCode', 'desktop'));
  });

  it('stays wired into main.mjs ahead of the first reader of a settings path', () => {
    // The fallbacks now land in GeoCode's own directory, so a missed injection no longer
    // writes into OpenChamber's — but it would still put shell data somewhere the product
    // never reads. And `sshManager` resolves a settings path at module top level and keeps
    // the string, so being wired in is not enough: it has to come first.
    const main = fs.readFileSync(
      new URL('../main.mjs', import.meta.url).pathname, 'utf8');
    const injectedAt = main.indexOf('applyShellDataRoot({');
    const firstReaderAt = main.indexOf('new ElectronSshManager(');
    expect(injectedAt).toBeGreaterThan(-1);
    expect(firstReaderAt).toBeGreaterThan(injectedAt);
  });

  it('refuses to guess when the home directory is missing', () => {
    // Failing loudly beats defaulting.
    for (const bad of [undefined, '', null, 42]) {
      expect(() => applyShellDataRoot({ environment: {}, homeDirectory: bad })).toThrow();
    }
  });
});
