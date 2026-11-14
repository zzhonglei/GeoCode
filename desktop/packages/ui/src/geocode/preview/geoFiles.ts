/**
 * The files that open as a map, by the names such files go by, with their format: it picks a file's icon and the
 * sidecars that belong to it. The reader opens only the formats these name: DRIVERS in
 * geoengine/python/geocodekit/preview/_source.py lists them by their drivers. GeoJSON is among them though it is text:
 * as text, a file is not opened past a size that geographic data often has.
 */
export type GeoDataFormat = 'shp' | 'gpkg' | 'tif' | 'geojson';

const GEO_DATA_FORMATS = new Map<string, GeoDataFormat>([
  ['shp', 'shp'],
  ['gpkg', 'gpkg'],
  ['tif', 'tif'],
  ['tiff', 'tif'],
  ['geojson', 'geojson'],
]);

export const geoDataFormat = (path: string): GeoDataFormat | null => {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? GEO_DATA_FORMATS.get(name.slice(dot + 1).toLowerCase()) ?? null : null;
};

export const isGeoDataFile = (path: string): boolean => geoDataFormat(path) !== null;
