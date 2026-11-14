import { describe, expect, test } from 'bun:test';

import type { FilesAPI } from '@/lib/api/types';
import { claimSidecars, withoutGeoSidecars, withoutListedSidecars } from './geoSidecars';

// A trailing slash marks a folder.
const listing = (...names: string[]) => names.map((name) => (
  name.endsWith('/') ? { name: name.slice(0, -1), isDirectory: true } : { name, isDirectory: false }
));

const shownNames = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);

const owners = (claims: Map<string, string[]>) => Object.fromEntries([...claims].map(([name, mains]) => [name, [...mains].sort()]));

// A disk that folds case answers for a name in any case; one that does not answers only for the exact name.
const disk = (names: string[], folds: boolean) => {
  const asked: string[] = [];
  const files: FilesAPI = {
    listDirectory: async (directory) => ({ directory, entries: [] }),
    search: async () => [],
    createDirectory: async (path) => ({ success: true, path }),
    statFile: async (path) => {
      asked.push(path);
      const name = path.split('/').pop() ?? '';
      const found = names.find((candidate) => (folds ? candidate.toLowerCase() === name.toLowerCase() : candidate === name));
      if (!found) throw new Error('File not found');
      return { path, isFile: true, size: 0 };
    },
  };
  return { files, asked };
};

describe('GeoCode: the sidecars of geographic data', () => {
  // Guards against hiding a file that is not part of the dataset, or leaving a part of it listed.
  test('a shapefile owns its parts and nothing else', () => {
    const claims = claimSidecars(listing(
      'roads.shp', 'roads.shx', 'roads.dbf', 'roads.prj', 'roads.cpg', 'roads.qix', 'roads.sbn', 'roads.shp.xml', 'roads.qml',
      'roads.xml', 'roads.txt', 'roads.csv', 'rivers.dbf', 'roads.dbf.bak',
    ), 'exact');
    expect(owners(claims)).toEqual({
      'roads.shx': ['roads.shp'], 'roads.dbf': ['roads.shp'], 'roads.prj': ['roads.shp'], 'roads.cpg': ['roads.shp'],
      'roads.qix': ['roads.shp'], 'roads.sbn': ['roads.shp'], 'roads.shp.xml': ['roads.shp'], 'roads.qml': ['roads.shp'],
    });
  });

  // Guards the parts named after the whole file name, which a stem-only rule would miss or mistake.
  test('a raster owns the parts named after its whole name and those named after its stem', () => {
    const claims = claimSidecars(listing(
      'scene.tif', 'scene.tif.aux.xml', 'scene.tif.ovr', 'scene.tif.msk', 'scene.tif.vat.dbf', 'scene.tfw', 'scene.wld',
      'scene.xml', 'scene_MTL.txt', 'scene.prj',
    ), 'exact');
    expect(Object.keys(owners(claims)).sort()).toEqual([
      'scene.tfw', 'scene.tif.aux.xml', 'scene.tif.msk', 'scene.tif.ovr', 'scene.tif.vat.dbf', 'scene.wld',
    ]);
  });

  // Guards SQLite's journals, which lose committed data when parted from their GeoPackage.
  test('a GeoPackage owns its journals', () => {
    expect(Object.keys(owners(claimSidecars(listing('db.gpkg', 'db.gpkg-wal', 'db.gpkg-shm', 'db.gpkg-journal'), 'exact'))).sort())
      .toEqual(['db.gpkg-journal', 'db.gpkg-shm', 'db.gpkg-wal']);
  });

  // Guards against hiding a lone part or a folder, which would vanish from the tree with nothing to own it.
  test('only a file beside its main file is a sidecar', async () => {
    expect(claimSidecars(listing('roads.dbf', 'roads.prj', 'scene.tif.aux.xml'), 'exact').size).toBe(0);
    expect(shownNames(await withoutGeoSidecars('/folder', listing('roads.shp', 'roads.dbf/'), disk([], true).files)))
      .toEqual(['roads.shp', 'roads.dbf']);
  });

  // Guards against giving a file two datasets share to only one of them.
  test('a file two main files are named for belongs to both', () => {
    expect(owners(claimSidecars(listing('a.shp', 'a.tif', 'a.qml', 'a.aux.xml', 'a.dbf'), 'exact'))).toEqual({
      'a.qml': ['a.shp', 'a.tif'], 'a.aux.xml': ['a.shp', 'a.tif'], 'a.dbf': ['a.shp'],
    });
  });

  // Guards against claiming, on a disk that keeps case, a file GDAL would not read as part of the dataset.
  test('on a disk that keeps case only the exact stem with a lower or upper suffix belongs', () => {
    expect(Object.keys(owners(claimSidecars(listing('ROADS.SHP', 'ROADS.DBF', 'ROADS.shx', 'roads.prj', 'ROADS.Cpg'), 'exact'))).sort())
      .toEqual(['ROADS.DBF', 'ROADS.shx']);
  });

  // Guards against asking the disk when nothing turns on its answer, and against claiming in doubt.
  test('the disk decides a pair that differs only in case, and is asked once a folder', async () => {
    const names = ['Roads.shp', 'roads.DBF', 'ROADS.Prj', 'notes.txt'];
    const folding = disk(names, true);
    expect(shownNames(await withoutGeoSidecars('/folds', listing(...names), folding.files))).toEqual(['Roads.shp', 'notes.txt']);
    await withoutGeoSidecars('/folds', listing(...names), folding.files);
    expect(folding.asked).toEqual(['/folds/rOADS.SHP']);

    const keeping = disk(names, false);
    expect(shownNames(await withoutGeoSidecars('/keeps', listing(...names), keeping.files))).toEqual(names);

    const exactOnly = disk(['roads.shp', 'roads.dbf'], true);
    expect(shownNames(await withoutGeoSidecars('/plain', listing('roads.shp', 'roads.dbf'), exactOnly.files))).toEqual(['roads.shp']);
    expect(exactOnly.asked).toEqual([]);
  });

  // Guards against a failed answer counting as a disk that folds case, and against keeping it as the answer.
  test('a disk that does not answer is taken as keeping case, and asked again next time', async () => {
    let calls = 0;
    const files: FilesAPI = {
      listDirectory: async (directory) => ({ directory, entries: [] }),
      search: async () => [],
      createDirectory: async (path) => ({ success: true, path }),
      statFile: async () => {
        calls += 1;
        throw new Error('Access denied');
      },
    };
    const names = ['Roads.shp', 'roads.dbf'];
    expect(shownNames(await withoutGeoSidecars('/denied', listing(...names), files))).toEqual(names);
    await withoutGeoSidecars('/denied', listing(...names), files);
    expect(calls).toBe(2);
  });

  // Guards against asking the disk, or pairing names by folded case, in a folder that shows its disk keeps case.
  test('two names that differ only in case show the disk keeps case', async () => {
    const both = disk([], true);
    expect(shownNames(await withoutGeoSidecars('/both', listing('a.shp', 'A.shp', 'A.dbf', 'a.Dbf'), both.files)))
      .toEqual(['a.shp', 'A.shp', 'a.Dbf']);
    expect(both.asked).toEqual([]);
  });

  // Guards a search that would hide a file it found alone, or one in another folder, leaving no way to find it.
  test('a search hides a sidecar only when its main file was found beside it', () => {
    const hits = ['/d/roads.shp', '/d/roads.dbf', '/d/roads.prj', '/d/rivers.dbf', '/e/roads.dbf', 'C:\\f\\scene.tif', 'C:\\f\\scene.tfw']
      .map((path) => ({ path }));
    expect(withoutListedSidecars(hits).map((hit) => hit.path)).toEqual(['/d/roads.shp', '/d/rivers.dbf', '/e/roads.dbf', 'C:\\f\\scene.tif']);
    expect(withoutListedSidecars([{ path: '/d/roads.dbf' }])).toEqual([{ path: '/d/roads.dbf' }]);
  });
});
