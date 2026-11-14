import { describe, expect, test } from 'bun:test';

import { FilesystemError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import {
  deleteDataset,
  refusesDatasetRename,
  refusesHiddenSidecarName,
  renameDataset,
  staleAfterUpload,
  staleBeforeUpload,
  staleOfReplace,
} from './geoDatasets';

const splitPath = (path: string): [string, string] => {
  const cut = path.lastIndexOf('/');
  return [path.slice(0, cut), path.slice(cut + 1)];
};

// Folders of files in memory. A disk that folds case finds a name in any case; `failing` names the files whose rename
// or delete fails, as a file another program holds open does on Windows.
const makeDisk = (layout: Record<string, string[]>, options: { folds?: boolean; failing?: string[] } = {}) => {
  const folders = new Map(Object.entries(layout).map(([folder, names]) => [folder, [...names]]));
  const failing = new Set(options.failing ?? []);
  const find = (folder: string, name: string) => (folders.get(folder) ?? []).find((candidate) => (
    options.folds ? candidate.toLowerCase() === name.toLowerCase() : candidate === name
  ));
  const files: FilesAPI = {
    listDirectory: async (directory) => ({
      directory,
      entries: (folders.get(directory) ?? []).map((name) => ({ name, path: `${directory}/${name}`, isDirectory: false })),
    }),
    search: async () => [],
    createDirectory: async (path) => ({ success: true, path }),
    statFile: async (path) => {
      const [folder, name] = splitPath(path);
      if (!find(folder, name)) throw new Error('File not found');
      return { path, isFile: true, size: 0 };
    },
    rename: async (oldPath, newPath) => {
      const [fromFolder, fromName] = splitPath(oldPath);
      const [toFolder, toName] = splitPath(newPath);
      const source = find(fromFolder, fromName);
      if (!source) throw new Error('File not found');
      if (failing.has(oldPath)) throw new Error('EBUSY');
      const existing = find(toFolder, toName);
      if (existing && !(toFolder === fromFolder && existing === source)) throw new FilesystemError('exists', { reason: 'already-exists' });
      folders.set(fromFolder, (folders.get(fromFolder) ?? []).filter((name) => name !== source));
      folders.set(toFolder, [...(folders.get(toFolder) ?? []), toName]);
      return { success: true, path: newPath };
    },
    delete: async (path) => {
      const [folder, name] = splitPath(path);
      if (failing.has(path)) throw new Error('EBUSY');
      folders.set(folder, (folders.get(folder) ?? []).filter((candidate) => candidate !== find(folder, name)));
      return { success: true };
    },
  };
  return {
    files,
    ls: (folder: string) => [...(folders.get(folder) ?? [])].sort(),
    has: (folder: string, name: string) => Boolean(find(folder, name)),
    put: (folder: string, name: string) => {
      if (!find(folder, name)) folders.set(folder, [...(folders.get(folder) ?? []), name]);
    },
  };
};

// Runs an upload as the file tree does: the first pass writes the files whose names are free and holds back the rest,
// which a second pass writes over when the user replaces them. `failing` names the files whose upload fails.
const upload = async (
  disk: ReturnType<typeof makeDisk>,
  folder: string,
  names: string[],
  options: { replace: boolean; failing?: string[] },
) => {
  const failing = new Set(options.failing ?? []);
  const drop = names.map((name) => new File([''], name));
  const first = await staleBeforeUpload(folder, drop, false, disk.files);
  const heldBack = drop.filter((file) => disk.has(folder, file.name));
  for (const file of drop) if (!heldBack.includes(file) && !failing.has(file.name)) disk.put(folder, file.name);
  await staleAfterUpload(folder, first, { replacing: false, heldBack, replaced: [] }, disk.files);
  if (!options.replace) return heldBack;
  const second = await staleBeforeUpload(folder, heldBack, true, disk.files);
  const replaced = heldBack.filter((file) => !failing.has(file.name)).map((file) => file.name);
  await staleAfterUpload(folder, second, { replacing: true, heldBack: [], replaced }, disk.files);
  return heldBack;
};

describe('GeoCode: a geographic dataset renamed, moved and deleted as one', () => {
  // Guards against leaving parts behind under the old name, and against QGIS's loss of a two-part suffix.
  test('a rename takes each part along, keeping what follows the stem', async () => {
    const disk = makeDisk({ '/d': ['roads.shp', 'roads.shx', 'roads.dbf', 'roads.shp.xml', 'roads.qml', 'notes.txt'] });
    await renameDataset(disk.files, '/d/roads.shp', '/d/streets.shp');
    expect(disk.ls('/d')).toEqual(['notes.txt', 'streets.dbf', 'streets.qml', 'streets.shp', 'streets.shp.xml', 'streets.shx']);

    const raster = makeDisk({ '/r': ['scene.tif', 'scene.tif.aux.xml', 'scene.tif.ovr', 'scene.tfw'] });
    await renameDataset(raster.files, '/r/scene.tif', '/r/dem.tif');
    expect(raster.ls('/r')).toEqual(['dem.tfw', 'dem.tif', 'dem.tif.aux.xml', 'dem.tif.ovr']);
  });

  // Guards against a drag leaving the parts in the old folder, split from the main file.
  test('a move takes the parts into the new folder', async () => {
    const disk = makeDisk({ '/a': ['db.gpkg', 'db.gpkg-wal', 'db.gpkg-shm'], '/b': [] });
    await renameDataset(disk.files, '/a/db.gpkg', '/b/db.gpkg');
    expect(disk.ls('/a')).toEqual([]);
    expect(disk.ls('/b')).toEqual(['db.gpkg', 'db.gpkg-shm', 'db.gpkg-wal']);
  });

  // Guards against a rename taking a file another dataset also owns.
  test('a part another main file also owns stays', async () => {
    const disk = makeDisk({ '/d': ['a.shp', 'a.dbf', 'a.tif', 'a.qml'] });
    await renameDataset(disk.files, '/d/a.shp', '/d/b.shp');
    expect(disk.ls('/d')).toEqual(['a.qml', 'a.tif', 'b.dbf', 'b.shp']);
  });

  // Guards against overwriting a file in the way, or moving half the dataset before finding it.
  test('a new name already taken changes nothing', async () => {
    const disk = makeDisk({ '/d': ['roads.shp', 'roads.dbf', 'streets.dbf'] });
    await expect(renameDataset(disk.files, '/d/roads.shp', '/d/streets.shp')).rejects.toBeInstanceOf(FilesystemError);
    expect(disk.ls('/d')).toEqual(['roads.dbf', 'roads.shp', 'streets.dbf']);
  });

  // Guards against a rename of case alone being refused as a clash on a disk that folds case.
  test('a rename of case alone goes through on a disk that folds case', async () => {
    const disk = makeDisk({ '/d': ['Roads.shp', 'Roads.dbf'] }, { folds: true });
    await renameDataset(disk.files, '/d/Roads.shp', '/d/roads.shp');
    expect(disk.ls('/d')).toEqual(['roads.dbf', 'roads.shp']);
  });

  // Guards against splitting the dataset when a part cannot move: what moved goes back.
  test('a part that cannot move puts the moved files back', async () => {
    const disk = makeDisk({ '/d': ['roads.shp', 'roads.shx', 'roads.dbf', 'roads.prj'] }, { failing: ['/d/roads.prj'] });
    const failed = await renameDataset(disk.files, '/d/roads.shp', '/d/streets.shp').then(() => false, () => true);
    expect(failed).toBe(true);
    expect(disk.ls('/d')).toEqual(['roads.dbf', 'roads.prj', 'roads.shp', 'roads.shx']);
  });

  // Guards a delete that leaves hidden parts behind, or deletes what is not the dataset's.
  test('a delete takes the parts the main file alone owns', async () => {
    const disk = makeDisk({ '/d': ['a.shp', 'a.shx', 'a.dbf', 'a.qml', 'a.tif', 'a.tif.aux.xml', 'b.dbf'] });
    expect((await deleteDataset(disk.files, '/d/a.shp')).success).toBe(true);
    expect(disk.ls('/d')).toEqual(['a.qml', 'a.tif', 'a.tif.aux.xml', 'b.dbf']);
  });

  // Guards the order of a delete: a main file that cannot go leaves the dataset whole.
  test('a main file that cannot be deleted leaves its parts', async () => {
    const disk = makeDisk({ '/d': ['a.shp', 'a.dbf'] }, { failing: ['/d/a.shp'] });
    expect(await deleteDataset(disk.files, '/d/a.shp').then(() => 'deleted', () => 'failed')).toBe('failed');
    expect(disk.ls('/d')).toEqual(['a.dbf', 'a.shp']);
  });

  // Guards a part that cannot be deleted: the rest still go, and it stays where it can be seen.
  test('a part that cannot be deleted stays and the others go', async () => {
    const disk = makeDisk({ '/d': ['a.shp', 'a.shx', 'a.dbf'] }, { failing: ['/d/a.dbf'] });
    expect((await deleteDataset(disk.files, '/d/a.shp')).success).toBe(true);
    expect(disk.ls('/d')).toEqual(['a.dbf']);
  });

  // Guards against parts left named for the old extension, and against refusing a rename that harms nothing.
  test('a main file with parts keeps its extension; one without may take any name', async () => {
    const disk = makeDisk({ '/d': ['roads.shp', 'roads.dbf', 'trip.geojson'] });
    expect(await refusesDatasetRename(disk.files, '/d/roads.shp', '/d/roads.txt')).toBe(true);
    expect(await refusesDatasetRename(disk.files, '/d/roads.shp', '/d/streets.SHP')).toBe(false);
    expect(await refusesDatasetRename(disk.files, '/d/trip.geojson', '/d/trip.json')).toBe(false);
  });

  // Guards against a new empty file overwriting a sidecar the tree hides, and against refusing a name that is free.
  test('a new file may not take the name of a hidden sidecar', async () => {
    const disk = makeDisk({ '/d': ['roads.shp', 'roads.prj', 'lone.prj'] });
    expect(await refusesHiddenSidecarName(disk.files, '/d/roads.prj')).toBe(true);
    expect(await refusesHiddenSidecarName(disk.files, '/d/roads.cpg')).toBe(false);
    expect(await refusesHiddenSidecarName(disk.files, '/d/lone.prj')).toBe(false);
  });

  // Guards against old sidecars describing replaced data, and against deleting what the upload brought or still uses.
  test('replacing a main file deletes the old sidecars the upload does not bring', async () => {
    const disk = makeDisk({ '/d': ['dem.tif', 'dem.tif.ovr', 'dem.tif.aux.xml', 'dem.qml', 'dem.shp', 'roads.shp', 'roads.dbf'] });
    await upload(disk, '/d', ['dem.tif', 'dem.tif.aux.xml', 'notes.txt'], { replace: true });
    expect(disk.ls('/d')).toEqual(['dem.qml', 'dem.shp', 'dem.tif', 'dem.tif.aux.xml', 'notes.txt', 'roads.dbf', 'roads.shp']);
  });

  // Guards against deleting a new sidecar the first pass wrote, which the replacing pass would take for old data.
  test('a new sidecar written in the first pass survives the replace, and the dialog names only the old', async () => {
    const disk = makeDisk({ '/d': ['a.shp', 'a.dbf', 'a.qix'] });
    const heldBack = await upload(disk, '/d', ['a.shp', 'a.dbf', 'a.prj'], { replace: false });
    expect(staleOfReplace(heldBack)).toEqual(['a.qix']);
    const replaced = makeDisk({ '/d': ['a.shp', 'a.dbf', 'a.qix'] });
    await upload(replaced, '/d', ['a.shp', 'a.dbf', 'a.prj'], { replace: true });
    expect(replaced.ls('/d')).toEqual(['a.dbf', 'a.prj', 'a.shp']);
  });

  // Guards against deleting the old data's sidecars when the new main file never arrived.
  test('a main file whose upload failed keeps its sidecars', async () => {
    const disk = makeDisk({ '/d': ['dem.tif', 'dem.tif.ovr'] });
    await upload(disk, '/d', ['dem.tif'], { replace: true, failing: ['dem.tif'] });
    expect(disk.ls('/d')).toEqual(['dem.tif', 'dem.tif.ovr']);
  });
});
