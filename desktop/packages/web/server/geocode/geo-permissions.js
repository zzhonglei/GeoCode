// The geo tools' titles in English, as the tray names their requests (ui/src/geocode/geoTools.ts, geoTrayLabel).
const TITLES = new Map([
  ['qgisdoc', 'QGIS Docs'],
  ['qgisrun', 'Run QGIS Algorithm'],
  ['geerun', 'Run Earth Engine Script'],
  ['osmsearch', 'OpenStreetMap Search'],
  ['osmprobe', 'OpenStreetMap Tags'],
  ['osmgetobjects', 'Download OpenStreetMap Objects'],
  ['osmgetfeatures', 'Download OpenStreetMap Features'],
]);

// Approved on their cards alone, which show what they will do: neither the algorithm nor the folder is named.
const IN_APP = new Set(['qgisrun', 'geerun', 'osmgetobjects', 'osmgetfeatures']);

/** What a notification says of a geo tool's request, as the tray says it; undefined for any other request. */
export const geoPermissionLabel = (action, resources) => {
  const title = TITLES.get(action);
  if (!title) return undefined;
  const resource = IN_APP.has(action)
    ? undefined
    : (Array.isArray(resources) ? resources : []).map(String).find((value) => value.trim());
  return resource ? `${title}: ${resource}` : title;
};
