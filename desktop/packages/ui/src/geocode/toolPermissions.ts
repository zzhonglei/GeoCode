/**
 * The geo tools' rows in the tool permissions, each set for the whole tool. The four OSM tools share one row: its rule,
 * `osm*`, holds for each of them, while each still asks, and saves "always allow", as itself.
 */
export const GEO_PERMISSION_KEYS = ['qgisdoc', 'qgisrun', 'geerun', 'osm*'] as const;

// English in every language, as upstream's rows are, with the acronyms and the brand written right; upstream's own keys
// keep the names upstream gives them. The shell's tools are the rows OPENCHAMBER_ACTIONS lists, in agentPermissionModel.ts.
const NAMES = new Map([
  ['qgisdoc', 'QGIS Doc'],
  ['qgisrun', 'QGIS Run'],
  ['geerun', 'GEE Run'],
  ['osm*', 'OSM'],
  ['geocode', 'GeoCode'],
  ['geocode_schedule', 'GeoCode Schedule'],
  ['geocode_web', 'GeoCode Web'],
  ['geocode_memory', 'GeoCode Memory'],
  ['geocode_knowledge', 'GeoCode Knowledge'],
  ['geocode_notify', 'GeoCode Notify'],
  ['geocode_render', 'GeoCode Render'],
  ['geocode_image', 'GeoCode Image'],
]);

/** The name a tool permission row shows for one of GeoCode's own keys; undefined for upstream's. */
export const permissionRowName = (key: string): string | undefined => NAMES.get(key);
