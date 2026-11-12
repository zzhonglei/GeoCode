import { describe, expect, test } from 'bun:test';

import type { FilesAPI } from '@/lib/api/types';
import { validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { isBinaryFile } from '@/lib/toolHelpers';
import { isGeoDataFile } from './geoFiles';

// Guards the patch in isBinaryFile: without it a click on geographic data reads the file as text, which for a
// Shapefile's parts or a GeoPackage is megabytes of nothing readable, and then refuses to open it.
describe('GeoCode: geographic data opens as a map', () => {
  test('the files that open as a map are never read as text', async () => {
    const reads: string[] = [];
    const files: FilesAPI = {
      listDirectory: async (directory) => ({ directory, entries: [] }),
      search: async () => [],
      createDirectory: async (path) => ({ success: true, path }),
      readFile: async (path) => {
        reads.push(path);
        return { content: '\u0000\u0001', path };
      },
    };
    for (const path of ['/data/roads.shp', '/data/Hubei.GPKG', 'C:\\data\\scene.tif', '/data/dem.tiff', '/data/route.geojson']) {
      expect(isGeoDataFile(path)).toBe(true);
      expect(isBinaryFile(path)).toBe(true);
      expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    }
    expect(reads).toEqual([]);
    expect(isGeoDataFile('/data/shp')).toBe(false);
    expect(isGeoDataFile('/data.shp/notes.txt')).toBe(false);
  });
});
