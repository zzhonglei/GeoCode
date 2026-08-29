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
];
let dataRoot;
let fakeHome;
let realHome;

const markedRegions = (source) => {
  const regions = [];
  for (let from = 0; ; ) {
    const start = source.indexOf('--- GeoCode:', from);
    if (start === -1) return regions;
    const end = source.indexOf('--- /GeoCode ---', start);
    // An unclosed region would otherwise slice to -1 and silently check nothing.
    if (end === -1) throw new Error(`Unclosed GeoCode region at ${start}`);
    regions.push(source.slice(start, end));
    from = end + 1;
  }
};

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
    // The fallback is unreachable in the product — main.mjs always injects — but it is the
    // last thing standing between a missed injection and writing into another product's
    // directory. It carries the `desktop/` segment on purpose: `.config/GeoCode` alone is the
    // kernel's config root, and a case-insensitive filesystem would merge `geocode` into it.
    //
    // Every region, not the first one: three of these files carry more than one patch now, and
    // reading only as far as the first closing marker checked a shrinking part of the file
    // while still passing.
    for (const file of PATCHED) {
      const regions = markedRegions(fs.readFileSync(path.join(serverRoot, file), 'utf8'));
      expect(regions.length).toBeGreaterThan(0);
      for (const region of regions) expect(region).not.toContain("'openchamber'");
      expect(regions.some((region) => region.includes("'GeoCode', 'desktop'"))).toBe(true);
    }
  });

  it('leaves no path computation reading the home directory unconditionally', () => {
    // Guards the merge that restores a hardcoded path in any one of them. The two files left
    // out resolve their own variable instead: package-manager returns early on the data root,
    // and managed-process-registry reads OPENCHAMBER_MANAGED_PROCESS_REGISTRY.
    for (const file of PATCHED) {
      expect(fs.readFileSync(path.join(serverRoot, file), 'utf8')).toContain('process.env.OPENCHAMBER_DATA_DIR');
    }
  });
});
