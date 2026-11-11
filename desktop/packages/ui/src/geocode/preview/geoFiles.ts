/**
 * The files that open as a map, by the names such files go by. The reader opens only the formats these name: DRIVERS
 * in geoengine/python/geocodekit/preview/_source.py lists them by their drivers.
 */
const GEO_DATA_EXTENSIONS = new Set(['shp', 'gpkg', 'tif', 'tiff']);

export const isGeoDataFile = (path: string): boolean => {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 && GEO_DATA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};
