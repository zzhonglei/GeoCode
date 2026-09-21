/* --- GeoCode: the shell runtime writes under GeoCode's data root, not OpenChamber's, and reads back from the
 * same file it wrote (docs/PATHS.md §3.3). --- */
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
  'lib/linear/auth.js',
  // The CLI resolves the same root to read the running app's `settings.json`.
  '../bin/lib/cli-paths.js',
  '../bin/lib/commands-connect-url.js',
];

// These keep upstream's `openchamber` path in code a GeoCode early return leaves unused.
const SHIELDED = new Set(['lib/package-manager.js', 'lib/linear/auth.js', 'index.js']);
let dataRoot;
let fakeHome;
let realHome;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-shell-root-'));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-shell-home-'));
  process.env.OPENCHAMBER_DATA_DIR = dataRoot;
  // HOME too, so a regression that falls back to the home directory writes into a temporary one.
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
    // Imported after the variable is set: the module resolves its path at import.
    const storage = await import('./lib/git/identity-storage.js');
    const profile = { id: 'geocode-round-trip', name: 'x', userName: 'x', userEmail: 'x@example.com' };

    storage.saveProfiles({ profiles: [profile] });
    expect(storage.getProfile(profile.id)).toMatchObject({ id: profile.id });

    // The round trip alone would still pass if both sides agreed on the old location.
    expect(fs.existsSync(path.join(dataRoot, 'git-identities.json'))).toBe(true);
  });

  it('never falls back into an OpenChamber directory', () => {
    for (const file of PATCHED) {
      const source = fs.readFileSync(path.join(serverRoot, file), 'utf8');
      expect([file, source.includes("'GeoCode', 'desktop'")]).toEqual([file, true]);
      if (SHIELDED.has(file)) continue;
      expect([file, source.includes("'.config', 'openchamber'")]).toEqual([file, false]);
    }
  });

  it('leaves no file outside the shielded three computing an OpenChamber root', () => {
    // The list above only checks what it names, which is how `lib/fs/routes.js` kept handing the renderer
    // an OpenChamber chats root until 2026-09-21. Scanned instead, with comments removed first: five of
    // today's mentions are prose describing the old location, and prose computes nothing.
    const SKIP = new Set(['node_modules', 'dist', '.turbo']);
    const ROOT_IN_CODE = /(['"])\.config\1\s*,\s*(['"])openchamber\2|\.config\/openchamber/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const relative = path.relative(serverRoot, full);
        if (ROOT_IN_CODE.test(code) && !SHIELDED.has(relative)) offenders.push(relative);
      }
    };
    walk(serverRoot);
    expect(offenders).toEqual([]);
  });

  it('leaves no path computation reading the home directory unconditionally', () => {
    const INJECTED = [
      /process\.env\.OPENCHAMBER_(?:DATA_DIR|MANAGED_PROCESS_REGISTRY)\b/,
      /readEnv\('OPENCHAMBER_DATA_DIR'\)/,
    ];
    for (const file of PATCHED) {
      const source = fs.readFileSync(path.join(serverRoot, file), 'utf8');
      expect([file, INJECTED.some((pattern) => pattern.test(source))]).toEqual([file, true]);
    }
  });
});
