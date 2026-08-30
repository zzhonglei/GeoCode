/* --- GeoCode: the shell runtime writes under GeoCode's data root, not OpenChamber's
 * (docs/PATHS.md §3.3).
 *
 * The round trip is the point. PATHS.md §5 records the accident this guards against: a path
 * renamed on the writing side but not the reading side, where the command reports success and
 * the file is simply never found again. Asserting the computed path would not catch it —
 * both sides have to land on the same file, and the file has to be under the root we set.
 * --- */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const PATCHED = [
  'index.js',
  'lib/git/identity-storage.js',
  'lib/git/service.js',
  'lib/opencode/proxy.js',
  'lib/package-manager.js',
  'lib/ui-auth/ui-auth.js',
  'lib/ui-auth/ui-passkeys.js',
  'lib/skills-catalog/disk-cache.js',
  'lib/small-model/index.js',
  'lib/session-goal/runtime.js',
  'lib/session-goal/objectives.js',
  'lib/session-assist/runtime.js',
  'lib/walkthrough/model-settings.js',
  'lib/walkthrough/store.js',
  'lib/github/auth.js',
  'lib/quota/credentials/store.js',
  'lib/opencode/managed-process-registry.js',
  // Outside `server/`, and the reason this list is not scoped to it: the published CLI
  // (`package.json` `bin`) resolves the same root, and it reads `settings.json` to find the
  // running desktop app. Renaming only the server's side split the pair (docs/PATHS.md §5).
  '../bin/lib/cli-paths.js',
  '../bin/lib/commands-connect-url.js',
];

/**
 * The one file whose `openchamber` literal stays: `package-manager.js` shields the upstream
 * resolution with an early return instead of replacing it, so those lines are unreachable and
 * byte-identical for merges (CONVENTIONS.md §5).
 */
const SHIELDED = 'lib/package-manager.js';
let dataRoot;
let fakeHome;
let realHome;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-shell-root-'));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-shell-home-'));
  process.env.OPENCHAMBER_DATA_DIR = dataRoot;
  // Redirect HOME too. Without it, a regression that resolves the home directory writes into
  // the developer's real ~/.config/openchamber — measured while mutation-testing this file.
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.OPENCHAMBER_DATA_DIR;
});

describe('shell data root', () => {
  it('completes a write/read round trip inside the configured root', async () => {
    // Imported after the variable is set: these modules resolve their path at module top
    // level, which is exactly why the injection in main.mjs has to come so early.
    const storage = await import('./lib/git/identity-storage.js');
    const profile = { id: 'geocode-round-trip', name: 'x', userName: 'x', userEmail: 'x@example.com' };

    storage.saveProfiles({ profiles: [profile] });
    expect(storage.getProfile(profile.id)).toMatchObject({ id: profile.id });

    // The round trip alone would still pass if both sides agreed on the OLD location, so
    // assert where the bytes actually landed.
    expect(fs.existsSync(path.join(dataRoot, 'git-identities.json'))).toBe(true);
  });

  it('never falls back into an OpenChamber directory', () => {
    // Asserted over the whole file rather than inside the patch markers. The marker form varies
    // — a block where the change carries a trade-off, a line-end note where it is one segment —
    // and an assertion that reads the markers tests how the patch is written instead of where
    // the bytes land. What has to hold is the same either way: this file names GeoCode's own
    // root, and no longer names OpenChamber's.
    //
    // The `desktop/` segment is deliberate: `.config/GeoCode` alone is the kernel's config root,
    // and on a case-insensitive filesystem `geocode` would land inside it.
    for (const file of PATCHED) {
      const source = fs.readFileSync(path.join(serverRoot, file), 'utf8');
      expect([file, source.includes("'GeoCode', 'desktop'")]).toEqual([file, true]);
      if (file === SHIELDED) continue;
      expect([file, source.includes("'.config', 'openchamber'")]).toEqual([file, false]);
    }
  });

  it('leaves no path computation reading the home directory unconditionally', () => {
    // Guards the merge that restores a hardcoded path. Two variables, not one: Electron main
    // injects the data root for most of these and a separate one for the process registry,
    // whose fallback is spelled out rather than derived from the root (shell-data-root.mjs).
    const INJECTED = ['process.env.OPENCHAMBER_DATA_DIR', 'process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY'];
    for (const file of PATCHED) {
      const source = fs.readFileSync(path.join(serverRoot, file), 'utf8');
      expect([file, INJECTED.some((name) => source.includes(name))]).toEqual([file, true]);
    }
  });
});
