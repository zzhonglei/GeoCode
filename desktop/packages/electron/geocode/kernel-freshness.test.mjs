/* --- GeoCode: guards a development launch running a staged kernel bundle older than the checked-out kernel source.
 * Pinned by source because the staging script runs on import. --- */
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
