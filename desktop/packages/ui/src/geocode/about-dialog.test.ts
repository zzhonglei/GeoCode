/* --- GeoCode: a merge must not bring upstream's About dialog back into the desktop shell
 * (docs/DESKTOP.md §4.6). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GEOCODE_REPOSITORY_URL } from './GeoCodeAboutDialog';

const read = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

describe('about dialog', () => {
  test('links to the GeoCode release repository', () => {
    expect(GEOCODE_REPOSITORY_URL).toBe('https://github.com/zzhonglei/GeoCode-Release');
  });

  test('App.tsx mounts it in the desktop shell in place of the upstream dialog', () => {
    const app = read('App.tsx');
    expect(app).toContain("import { AboutDialog as UpstreamAboutDialog } from '@/components/ui/AboutDialog'");
    expect(app).toContain('isDesktopShell() ? <GeoCodeAboutDialog {...props} /> : <UpstreamAboutDialog {...props} />');
    expect(app.match(/<AboutDialog\b/g)?.length).toBe(1);
  });
});
