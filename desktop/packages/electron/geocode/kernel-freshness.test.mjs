/* --- GeoCode: a development launch runs the kernel that is checked out, not one staged days ago.
 *
 * The staged bundle carries a stamp of the kernel tree it came from; the staging script reuses it
 * only while that stamp matches the checkout, and both development scripts run the staging before
 * Electron. Pinned by source because the script runs on import. Found the hard way: every real
 * session from 08-30 to 09-06 ran a bundle from 08-30 while the kernel source moved on. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(electronRoot, 'scripts/prepare-geocode-kernel.mjs'), 'utf8');
const desktopPackage = JSON.parse(fs.readFileSync(path.resolve(electronRoot, '../../package.json'), 'utf8'));

describe('kernel bundle freshness', () => {
  it('the staging script reuses a bundle only when its stamp matches the checked-out kernel tree', () => {
    expect(script).toContain("stamp.kernelTree !== currentKernelTree()");
    expect(script).toContain('if (stamp.kernelDirty) return');
    expect(script).toContain('if (kernelTreeDirty()) return');
    expect(script).toContain('if (fs.existsSync(bundlePath) && !force && !stale) {');
  });

  it('both development scripts stage the kernel before starting Electron', () => {
    for (const name of ['electron:dev', 'electron:dev:bundled']) {
      const command = desktopPackage.scripts[name];
      expect([name, command.startsWith('node ./packages/electron/scripts/prepare-geocode-kernel.mjs && ')]).toEqual([name, true]);
    }
  });
});
