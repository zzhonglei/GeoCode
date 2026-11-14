import { isFileMissingError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import { geoDataFormat, type GeoDataFormat } from '@/geocode/preview/geoFiles';

/**
 * The files that belong to a geographic dataset beside its main file. A sidecar sits in the main file's folder and is
 * named for it: its stem (the name less its last extension) or its whole name, followed by a suffix its format keeps
 * there. The suffixes are those QGIS counts as sidecars (QgsFileUtils::sidecarFilesForPath), those GDAL reads or
 * writes beside these formats, those Esri lists for a shapefile, QGIS's style and metadata, and SQLite's journals,
 * without which a GeoPackage can lose committed data.
 *
 * Whether names that differ only in case are one file is the filesystem's to say, as it is when QGIS and GDAL look a
 * sidecar up by name: on a disk that folds case `Roads.shp` owns `roads.DBF`; on one that does not, a main file owns
 * only the exact name with the suffix in lower or upper case, the spellings GDAL tries. A disk is asked only when a
 * folder holds such a pair, and an answer that does not come counts as not folding, so nothing is claimed in doubt.
 */

// Also listed, each for its own use: SHAPEFILE in geoengine/src/qgis/plan.ts (the names that make an output's name
// taken) and SIDECARS with SQLITE in kernel/packages/core/src/geocode/snapshot.ts (the files a snapshot keeps together).
const AFTER_STEM = {
  shp: ['.shx', '.dbf', '.prj', '.cpg', '.qix', '.sbn', '.sbx', '.fbn', '.fbx', '.ain', '.aih', '.atx', '.ixs', '.mxs', '.idm', '.ind', '.qpj', '.fix'],
  tif: ['.tfw', '.tifw', '.tiffw', '.wld', '.ovr', '.aux'],
  gpkg: [],
  geojson: [],
} satisfies Record<GeoDataFormat, string[]>;

const AFTER_NAME = {
  shp: ['.xml'],
  tif: ['.ovr', '.msk', '.aux', '.vat.dbf', '.vat.cpg', '.xml'],
  gpkg: ['-wal', '-shm', '-journal'],
  geojson: [],
} satisfies Record<GeoDataFormat, string[]>;

const AFTER_STEM_OF_ANY = ['.aux.xml', '.qml', '.qmd'];

const AFTER_NAME_OF_ANY = ['.aux.xml'];

type Listed = { name: string; isDirectory: boolean };

/** How a folder's disk compares names: `folded` when names differing only in case are one file. */
export type CaseRule = 'folded' | 'exact';

/** The names a main file's sidecars may have, lower-cased under `folded`; none for a file that is not one. */
const sidecarSpellings = (main: string, rule: CaseRule): string[] => {
  const format = geoDataFormat(main);
  if (!format) return [];
  const stem = main.slice(0, main.lastIndexOf('.'));
  return [
    ...[...AFTER_STEM[format], ...AFTER_STEM_OF_ANY].map((suffix) => [stem, suffix]),
    ...[...AFTER_NAME[format], ...AFTER_NAME_OF_ANY].map((suffix) => [main, suffix]),
  ].flatMap(([prefix, suffix]) => (rule === 'folded'
    ? [`${prefix}${suffix}`.toLowerCase()]
    : [`${prefix}${suffix}`, `${prefix}${suffix.toUpperCase()}`]));
};

/** For each sidecar in a folder's listing, the main files that own it: one, or several sharing a stem. */
export const claimSidecars = (entries: readonly Listed[], rule: CaseRule): Map<string, string[]> => {
  const names = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
  const byKey = new Map(names.map((name) => [rule === 'folded' ? name.toLowerCase() : name, name]));
  const claims = new Map<string, string[]>();
  for (const main of names) {
    for (const spelling of sidecarSpellings(main, rule)) {
      const name = byKey.get(spelling);
      if (!name) continue;
      const owners = claims.get(name) ?? [];
      if (!owners.includes(main)) claims.set(name, [...owners, main]);
    }
  }
  return claims;
};

const sameClaims = (a: Map<string, string[]>, b: Map<string, string[]>): boolean => (
  a.size === b.size && [...a].every(([name, owners]) => b.get(name)?.length === owners.length)
);

const caseRules = new Map<string, CaseRule>();

const swapCase = (name: string): string => [...name].map((char) => (
  char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()
)).join('');

const caseRuleOf = async (directory: string, entries: readonly Listed[], files: FilesAPI): Promise<CaseRule> => {
  const lowered = entries.map((entry) => entry.name.toLowerCase());
  // Two names that differ only in case can sit together only on a disk that does not fold case.
  if (new Set(lowered).size < lowered.length) return 'exact';
  const known = caseRules.get(directory);
  if (known) return known;
  const main = entries.find((entry) => !entry.isDirectory && geoDataFormat(entry.name));
  if (!main || !files.statFile) return 'exact';
  try {
    await files.statFile(`${directory.replace(/[\\/]+$/, '')}/${swapCase(main.name)}`);
    caseRules.set(directory, 'folded');
    return 'folded';
  } catch (error) {
    if (isFileMissingError(error)) caseRules.set(directory, 'exact');
    return 'exact';
  }
};

/** The sidecars of a folder's listing, compared as the folder's disk compares names. */
export const sidecarClaims = async (directory: string, entries: readonly Listed[], files: FilesAPI): Promise<Map<string, string[]>> => {
  const exact = claimSidecars(entries, 'exact');
  const folded = claimSidecars(entries, 'folded');
  if (sameClaims(exact, folded)) return exact;
  return (await caseRuleOf(directory, entries, files)) === 'folded' ? folded : exact;
};

/** A folder's listing without the sidecars of the geographic datasets in it. */
export const withoutGeoSidecars = async <Entry extends Listed>(directory: string, entries: Entry[], files: FilesAPI): Promise<Entry[]> => {
  const claims = await sidecarClaims(directory, entries, files);
  return claims.size === 0 ? entries : entries.filter((entry) => !claims.has(entry.name));
};

const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));

/**
 * Files found by a search, without the sidecars whose main file was found with them. A folder's disk is not asked
 * here; one a file tree has already asked is compared as it answered.
 */
export const withoutListedSidecars = <Hit extends { path: string }>(hits: Hit[]): Hit[] => {
  const slashed = (path: string) => path.replace(/\\/g, '/');
  const byFolder = new Map<string, Listed[]>();
  for (const hit of hits) {
    const path = slashed(hit.path);
    const folder = parentOf(path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), { name: path.slice(folder.length + 1), isDirectory: false }]);
  }
  const hidden = new Set<string>();
  for (const [folder, names] of byFolder) {
    for (const name of claimSidecars(names, caseRules.get(folder) ?? 'exact').keys()) hidden.add(`${folder}/${name}`);
  }
  return hidden.size === 0 ? hits : hits.filter((hit) => !hidden.has(slashed(hit.path)));
};

/**
 * A main file's git state when it has none of its own but a sidecar of it changed: the dataset is modified, though
 * the file listed for it is not. `statuses` holds the changed files by path, as a file tree reads them.
 */
export const datasetStatus = (statuses: ReadonlyMap<string, string | null>, path: string): 'git-modified' | null => {
  const folder = parentOf(path);
  const prefix = folder ? `${folder}/` : '';
  const changed = sidecarSpellings(path.slice(prefix.length), 'exact').some((name) => statuses.get(`${prefix}${name}`));
  return changed ? 'git-modified' : null;
};
