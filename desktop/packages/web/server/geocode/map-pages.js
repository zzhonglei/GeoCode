// What the agent reads about drawing maps of geographic data in a geocode_render page, beside upstream's rules for a
// page: how, at the end of the html parameter's description in lib/agent-tool/runtime.js, and when, in the render
// guidance of lib/session-knowledge/runtime.js. The page gets maplibregl and the geocode functions from
// packages/ui/src/geocode/pageMaps/pageMapKit.ts, and the limit on features is FEATURES in
// geoengine/python/geocodekit/preview/_page.py; change them together.

export const MAP_PAGE_DESCRIPTION = [
  'Maps of geographic data: draw them with MapLibre GL JS, already on the page as `maplibregl` and the only map library that loads offline.',
  'Two built-in functions read the user\'s local data for it; name each file by its complete absolute path, written as is in the page, and await the result:',
  '`geocode.vector(path, { layer, fields })` returns a GeoJSON FeatureCollection in longitude and latitude, each feature with an id.',
  'It carries only the attributes named in fields, none by default, so name every field the styles and interactions use. It does not read data of more than 500,000 features.',
  '`geocode.raster(path, { layer, bands })` returns what geotiff.js\'s readRasters does: an array with a Float32Array for each band (default [1]), and width and height on it.',
  'The raster is reprojected to Web Mercator, with nodata as NaN; coordinates holds its four corners for an image or canvas source, and palette, for a band with a color table, maps each value present to its color.',
  'layer names one layer of a file that holds several, such as a GeoPackage.',
  '`geocode.basemap()` returns the style of the basemap the user chose in GeoCode\'s settings; pass it as the map\'s `style`.',
  'Prefer opaque fills for polygons, as desktop GIS draws them.',
  'Add controls around the map where they help the user explore the data.',
  'For example: `const roads = await geocode.vector(\'/data/city.gpkg\', { layer: \'roads\', fields: [\'name\', \'class\'] }); map.addSource(\'roads\', { type: \'geojson\', data: roads });`',
].join(' ');

export const MAP_PAGE_GUIDANCE = 'When you show the user the geographic data your work produced, or help them understand a geographic dataset, draw it on an interactive map.';
