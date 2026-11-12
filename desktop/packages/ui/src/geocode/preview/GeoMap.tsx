import React from 'react';
import { addProtocol, Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { identifyGeoFeature, refusalCode, FORMS, tileAddress, tileRequestPath, TILE_SCHEME, type FoundFeature, type GeoBounds, type GeoDescription, type Form, type Target } from './previewClient';

/** Where a map was last looked at, kept while its tab is hidden and the map itself is not. */
export type MapView = { center: [number, number]; zoom: number };

// A raster's tile is an image 512 pixels wide drawn 256 wide, so it is sharp on a display of twice the density.
const RASTER_TILE = 256;
// Half the side of the map's plane, in metres.
const HALF = 20037508.342789244;
// How near a click must be to a feature to pick it, in pixels.
const PICK_RADIUS = 5;
// The deepest tiles asked of a vector layer; deeper, the map draws these larger. Their vertices sit a pixel apart at
// the deepest the map zooms.
const VECTOR_DEPTH = 20;
const COLOR = '#3b82f6';
// The map's layers that draw each of a vector layer's forms.
const DRAWN_AS = { points: ['point'], lines: ['line', 'small-line'], polygons: ['fill', 'outline', 'small-polygon'] } satisfies Record<Form, readonly string[]>;

const show = (map: MapLibreMap, shown: readonly Form[]) => {
  for (const form of FORMS) {
    for (const layer of DRAWN_AS[form]) map.setLayoutProperty(layer, 'visibility', shown.includes(form) ? 'visible' : 'none');
  }
};

/**
 * Told the code a tile was refused with, by how the tiles' addresses begin: a tile that failed is not an empty one.
 * Several maps may show the same data, as a file's tab and its fullscreen view do.
 */
const refusals = new Map<string, Set<(code: string) => void>>();

setWorkerUrl(workerUrl);

// The map's tiles go through the window's own requests, as everything else asked of the shell server does.
addProtocol(TILE_SCHEME, async (parameters, abortController) => {
  const response = await runtimeFetch(tileRequestPath(parameters.url), { signal: abortController.signal });
  // Nothing of the data lies in this tile, which the map takes an empty answer to mean.
  if (response.status === 204) return { data: new ArrayBuffer(0) };
  if (response.ok) return { data: await response.arrayBuffer() };
  const code = await refusalCode(response);
  for (const [beginning, told] of refusals) {
    if (parameters.url.startsWith(beginning)) told.forEach((tell) => tell(code));
  }
  throw new Error(`The tile could not be read (${code})`);
});

/** The deepest zoom at which a tile still shows no more pixels than the raster has there. */
const nativeZoom = (width: number, bounds: GeoBounds): number => {
  const degreesPerPixel = (bounds[2] - bounds[0]) / width;
  return Math.max(0, Math.min(22, Math.ceil(Math.log2(360 / (degreesPerPixel * RASTER_TILE * 2)))));
};

const GeoMap: React.FC<{
  target: Target;
  description: GeoDescription;
  /** Where the data lies; a dataset with no place on the map gets no map. */
  bounds: GeoBounds;
  /** Those of a vector layer's points, lines and polygons that are drawn, and so can be clicked. */
  shown: readonly Form[];
  /** Read when the map is made and written when it goes. */
  view: React.MutableRefObject<MapView | null>;
  onPick: (found: FoundFeature | null) => void;
  /** A tile or a click was refused, with the code it was refused with. */
  onRefused: (code: string) => void;
  /** The map could not be made at all, as on a computer without WebGL. */
  onFailed: () => void;
}> = ({ target, description, bounds, shown, view, onPick, onRefused, onFailed }) => {
  const container = React.useRef<HTMLDivElement>(null);
  const made = React.useRef<MapLibreMap | null>(null);
  // The map is made once for the data it shows; what it tells goes to whoever listens now, and a click looks among
  // what is shown now.
  const listeners = React.useRef({ onPick, onRefused, onFailed });
  const showing = React.useRef(shown);
  React.useEffect(() => {
    listeners.current = { onPick, onRefused, onFailed };
    showing.current = shown;
  });

  React.useEffect(() => {
    if (!container.current) return;
    const tiles = tileAddress(target, description.stamp);
    const beginning = tiles.slice(0, tiles.indexOf('&z='));
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: container.current,
        style: { version: 8, sources: {}, layers: [] },
        ...(view.current ? view.current : { bounds, fitBoundsOptions: { padding: 24 } }),
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      listeners.current.onFailed();
      return;
    }
    map.touchZoomRotate.disableRotation();
    made.current = map;
    const tell = (code: string) => listeners.current.onRefused(code);
    const told = refusals.get(beginning) ?? new Set();
    refusals.set(beginning, told.add(tell));

    let clicks = 0;
    map.on('load', () => {
      if (description.kind === 'raster') {
        map.addSource('data', { type: 'raster', tiles: [tiles], tileSize: RASTER_TILE, bounds, maxzoom: nativeZoom(description.width, bounds) });
        map.addLayer({ id: 'data', type: 'raster', source: 'data', paint: { 'raster-fade-duration': 0 } });
        return;
      }
      // A vector tile's layers: polygons, lines and points as they are, and a dot for each line and polygon too small
      // to be seen as one at the tile's zoom.
      // Asked of every tile in view, not only those within the bounds: a file's own record of its extent may be out of
      // date, and what lies outside it would never be drawn.
      map.addSource('data', { type: 'vector', tiles: [tiles], maxzoom: VECTOR_DEPTH });
      map.addLayer({ id: 'fill', type: 'fill', source: 'data', 'source-layer': 'polygons', paint: { 'fill-color': COLOR, 'fill-opacity': 0.3 } });
      map.addLayer({ id: 'outline', type: 'line', source: 'data', 'source-layer': 'polygons', paint: { 'line-color': COLOR, 'line-width': 1 } });
      map.addLayer({ id: 'line', type: 'line', source: 'data', 'source-layer': 'lines', paint: { 'line-color': COLOR, 'line-width': 1 } });
      map.addLayer({ id: 'small-polygon', type: 'circle', source: 'data', 'source-layer': 'small-polygons', paint: { 'circle-color': COLOR, 'circle-radius': 0.75 } });
      map.addLayer({ id: 'small-line', type: 'circle', source: 'data', 'source-layer': 'small-lines', paint: { 'circle-color': COLOR, 'circle-radius': 0.75 } });
      map.addLayer({ id: 'point', type: 'circle', source: 'data', 'source-layer': 'points', paint: { 'circle-color': COLOR, 'circle-radius': 2.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.5 } });
      show(map, showing.current);
      map.on('click', (event) => {
        // With nothing shown there is nothing to click.
        if (showing.current.length === 0) return;
        const click = (clicks += 1);
        const at = MercatorCoordinate.fromLngLat(event.lngLat);
        // Metres of the plane to a pixel, at the map's zoom.
        const tolerance = ((2 * HALF) / (512 * 2 ** map.getZoom())) * PICK_RADIUS;
        void identifyGeoFeature(target, description.stamp, { x: (at.x * 2 - 1) * HALF, y: (1 - at.y * 2) * HALF, tolerance }, showing.current).then((outcome) => {
          // A click answered after a later one says nothing any more.
          if (click !== clicks) return;
          if (outcome.ok) return listeners.current.onPick(outcome.value);
          // Not a click that landed on nothing.
          listeners.current.onPick(null);
          listeners.current.onRefused(outcome.code);
        });
      });
    });

    return () => {
      clicks += 1;
      made.current = null;
      told.delete(tell);
      if (told.size === 0) refusals.delete(beginning);
      const center = map.getCenter();
      view.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
      map.remove();
    };
  }, [target, description, bounds, view]);

  React.useEffect(() => {
    // Before the map has its layers, they are shown as asked when it gets them.
    if (made.current?.getLayer('point')) show(made.current, shown);
  }, [shown]);

  return <div ref={container} className="h-full w-full" />;
};

export default GeoMap;
