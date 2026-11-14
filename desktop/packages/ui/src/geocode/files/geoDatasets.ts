import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { FilesAPI } from '@/lib/api/types';
import { useI18nStore } from '@/lib/i18n';
import { geoDataFormat } from '@/geocode/preview/geoFiles';
import { datasetText } from './datasetText';
import { sidecarClaims } from './geoSidecars';

/**
 * Renaming, moving and deleting a geographic dataset as one, as QGIS and ArcGIS do: its main file takes the sidecars
 * it alone owns, read from its folder at the time, so none is left behind hidden or split from the data it describes.
 * A sidecar keeps what follows the main file's stem (`roads.shp.xml` becomes `streets.shp.xml`), as GDAL renames a
 * dataset; QGIS keeps only the last suffix and loses those of two parts. The file trees reach these only through
 * moveWorkspacePath, their create and delete dialogs and useFileTreeUpload: another way to rename, write, upload or
 * delete there acts on the file alone.
 */

const parentAndName = (path: string) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { parent: path.slice(0, cut), name: path.slice(cut + 1) };
};

const stemOf = (name: string): string => name.slice(0, name.lastIndexOf('.'));

const extensionOf = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '');

const text = () => datasetText(useI18nStore.getState().locale);

/** The sidecars a dataset's main file alone owns, by name; none for any other file. */
export const datasetParts = async (files: FilesAPI, path: string): Promise<string[]> => {
  if (!geoDataFormat(path)) return [];
  const { parent, name } = parentAndName(path);
  const { entries } = await files.listDirectory(parent, { respectGitignore: false });
  const claims = await sidecarClaims(parent, entries, files);
  return [...claims].filter(([, owners]) => owners.length === 1 && owners[0] === name).map(([part]) => part);
};

/**
 * Whether a rename would give a dataset's main file another extension, which the names of its sidecars carry; it
 * tells the user so when it would. A main file with no sidecars may take any name.
 */
export const refusesDatasetRename = async (files: FilesAPI, fromPath: string, toPath: string): Promise<boolean> => {
  const from = parentAndName(fromPath).name;
  const extension = extensionOf(from);
  if (extensionOf(parentAndName(toPath).name).toLowerCase() === extension.toLowerCase()) return false;
  if ((await datasetParts(files, fromPath)).length === 0) return false;
  toast.error(text().extensionKept(from, extension));
  return true;
};

/**
 * Whether a new file would take the name of a sidecar the tree hides, which writing it would empty unseen; it tells
 * the user so when it would. Any other name is left as upstream treats it. A folder that cannot be read refuses
 * nothing: the write then meets the same failure.
 */
export const refusesHiddenSidecarName = async (files: FilesAPI, path: string): Promise<boolean> => {
  const { parent, name } = parentAndName(path);
  const listed = await files.listDirectory(parent, { respectGitignore: false }).catch(() => null);
  if (!listed) return false;
  const owner = (await sidecarClaims(parent, listed.entries, files)).get(name)?.[0];
  if (!owner) return false;
  toast.error(text().sidecarTaken(name, owner));
  return true;
};

/**
 * Renames or moves a file as `files.rename` does; a dataset's main file takes its sidecars along. A part that cannot
 * move, a taken name among them, puts the moved files back and fails with that part's error.
 */
export const renameDataset = async (files: FilesAPI, fromPath: string, toPath: string): Promise<{ success: boolean; path: string }> => {
  if (!files.rename) throw new Error('Renaming is not supported');
  const rename = files.rename;
  const parts = await datasetParts(files, fromPath);
  if (parts.length === 0) return rename(fromPath, toPath);

  const from = parentAndName(fromPath);
  const to = parentAndName(toPath);
  const stem = stemOf(from.name);
  const moves = parts.map((part) => ({
    from: `${from.parent}/${part}`,
    to: `${to.parent}/${stemOf(to.name)}${part.slice(stem.length)}`,
  }));
  const result = await rename(fromPath, toPath);
  if (!result.success) return result;
  const moved: typeof moves = [];
  try {
    for (const move of moves) {
      if (!(await rename(move.from, move.to)).success) throw new Error(`Could not move ${move.from}`);
      moved.push(move);
    }
  } catch (error) {
    const main = { from: fromPath, to: toPath };
    const stranded = new Set<string>();
    for (const back of [...moved].reverse().concat(main)) {
      if (!(await rename(back.to, back.from).then((answer) => answer.success, () => false))) stranded.add(back.to);
    }
    if (stranded.size > 0) {
      toast.error(text().datasetSplit([main, ...moves].map((move) => (stranded.has(move.to) ? move.to : move.from))));
    }
    throw error;
  }
  return result;
};

/**
 * A replacing upload deletes the sidecars of the old data that it does not bring, as GDAL deletes a dataset it writes
 * over: left beside the new data they describe the old, and GDAL draws a stale `.ovr` as the new raster's overviews.
 *
 * An upload runs twice. The first pass writes the files whose names are free and holds back the rest; the second
 * replaces those the user confirms. By then the first pass has written the upload's new sidecars beside the old main
 * files, so the old sidecars are read in the first pass, before anything is written, and kept with the held-back
 * files for the second to delete and the replace dialog to name.
 */
type Stale = Map<string, string[]>;

const staleOfHeldBack = new WeakMap<readonly File[], Stale>();

const readStale = async (files: FilesAPI, directory: string, names: readonly string[]): Promise<Stale> => {
  const stale: Stale = new Map();
  if (!names.some((name) => geoDataFormat(name))) return stale;
  // A folder that cannot be read names none, and the upload goes on as upstream does it.
  const listed = await files.listDirectory(directory, { respectGitignore: false }).catch(() => null);
  if (!listed) return stale;
  const claims = await sidecarClaims(directory, listed.entries, files);
  const brought = new Set(names.map((name) => name.toLowerCase()));
  for (const [part, owners] of claims) {
    if (owners.length !== 1 || !names.includes(owners[0]) || brought.has(part.toLowerCase())) continue;
    stale.set(owners[0], [...(stale.get(owners[0]) ?? []), part]);
  }
  return stale;
};

/** Before an upload's pass: the old sidecars its main files would leave, read by the first pass, kept for the second. */
export const staleBeforeUpload = async (
  directory: string,
  uploads: readonly File[],
  replacing: boolean,
  files: FilesAPI | undefined = getRegisteredRuntimeAPIs()?.files,
): Promise<Stale> => {
  if (replacing) return staleOfHeldBack.get(uploads) ?? new Map();
  return files ? readStale(files, directory, uploads.map((file) => file.name)) : new Map();
};

/**
 * After an upload's pass: the first keeps the old sidecars with the files it held back; the second deletes those of
 * the main files it replaced. One that cannot be deleted is named and stays.
 */
export const staleAfterUpload = async (
  directory: string,
  stale: Stale,
  pass: { replacing: boolean; heldBack: readonly File[]; replaced: readonly string[] },
  files: FilesAPI | undefined = getRegisteredRuntimeAPIs()?.files,
): Promise<void> => {
  if (!pass.replacing) {
    staleOfHeldBack.set(pass.heldBack, stale);
    return;
  }
  const remove = files?.delete;
  const parts = pass.replaced.flatMap((name) => stale.get(name) ?? []);
  if (!remove || parts.length === 0) return;
  const left: string[] = [];
  for (const part of parts) {
    const deleted = await remove(`${directory}/${part}`).then((answer) => answer.success, () => false);
    if (!deleted) left.push(part);
  }
  if (left.length > 0) toast.error(text().partsLeft(left));
};

/** The old sidecars that replacing these held-back files would delete, for the replace dialog. */
export const staleOfReplace = (heldBack: readonly File[]): string[] => [...(staleOfHeldBack.get(heldBack)?.values() ?? [])].flat();

/**
 * Deletes a file as `files.delete` does; a dataset's main file takes its sidecars along. The main file goes first, so
 * one that cannot be deleted leaves the dataset whole; a sidecar that cannot be deleted is named and stays listed.
 */
export const deleteDataset = async (files: FilesAPI, path: string): Promise<{ success: boolean }> => {
  if (!files.delete) throw new Error('Deleting is not supported');
  const remove = files.delete;
  const parts = await datasetParts(files, path);
  const result = await remove(path);
  if (!result.success || parts.length === 0) return result;
  const { parent } = parentAndName(path);
  const left: string[] = [];
  for (const part of parts) {
    const deleted = await remove(`${parent}/${part}`).then((answer) => answer.success, () => false);
    if (!deleted) left.push(part);
  }
  if (left.length > 0) toast.error(text().partsLeft(left));
  return result;
};
