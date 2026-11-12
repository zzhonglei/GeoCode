import React from 'react';
import { addProtocol, Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { previewText } from './previewText';
import { stilled } from './stilled';
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
  /** Where the pointer is over the map, as a longitude and a latitude, or that it has left. */
  onPointer: (at: readonly [number, number] | null) => void;
  /** A tile or a click was refused, with the code it was refused with. */
  onRefused: (code: string) => void;
  /** The map could not be made at all, as on a computer without WebGL. */
  onFailed: () => void;
}> = ({ target, description, bounds, shown, view, onPick, onPointer, onRefused, onFailed }) => {
  const { locale } = useI18n();
  const text = previewText(locale);
  // The room the map is given, and within it the map itself, which keeps the size it was last drawn at.
  const room = React.useRef<HTMLDivElement>(null);
  const container = React.useRef<HTMLDivElement>(null);
  const made = React.useRef<MapLibreMap | null>(null);
  // The map is made once for the data it shows; what it tells goes to whoever listens now, and a click looks among
  // what is shown now.
  const listeners = React.useRef({ onPick, onPointer, onRefused, onFailed });
  const showing = React.useRef(shown);
  React.useEffect(() => {
    listeners.current = { onPick, onPointer, onRefused, onFailed };
    showing.current = shown;
  });

  React.useEffect(() => {
    const around = room.current;
    const within = container.current;
    if (!around || !within) return;
    const fit = () => {
      within.style.width = `${around.clientWidth}px`;
      within.style.height = `${around.clientHeight}px`;
    };
    fit();
    const tiles = tileAddress(target, description.stamp);
    const beginning = tiles.slice(0, tiles.indexOf('&z='));
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: within,
        style: { version: 8, sources: {}, layers: [] },
        ...(view.current ? view.current : { bounds, fitBoundsOptions: { padding: 24 } }),
        attributionControl: false,
        // Sized below, once its room has stopped changing: drawn whole again for every frame of a panel sliding,
        // it made the slide drop frames. Meanwhile it stays as it was drawn, centred in its room, whose moving
        // edges cover and uncover it; a map that follows its room keeps its centre in the same way, so nothing
        // jumps when it is drawn again.
        trackResize: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      listeners.current.onFailed();
      return;
    }
    map.touchZoomRotate.disableRotation();
    made.current = map;
    const sizing = stilled(() => {
      if (within.clientWidth === around.clientWidth && within.clientHeight === around.clientHeight) return;
      fit();
      // Drawn at once: a canvas is blank from being sized until it is next drawn, which shows as a flicker.
      map.resize();
      map.redraw();
    });
    const sized = new ResizeObserver(() => runWhenLayoutSettled(sizing.ask));
    sized.observe(around);
    const tell = (code: string) => listeners.current.onRefused(code);
    const told = refusals.get(beginning) ?? new Set();
    refusals.set(beginning, told.add(tell));

    // Wrapped: over a copy of the world beside the one the data is in, the map counts longitudes on past 180.
    map.on('mousemove', (event) => {
      const at = event.lngLat.wrap();
      listeners.current.onPointer([at.lng, at.lat]);
    });
    map.on('mouseout', () => listeners.current.onPointer(null));

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
        const at = MercatorCoordinate.fromLngLat(event.lngLat.wrap());
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
      sized.disconnect();
      cancelWhenLayoutSettled(sizing.ask);
      sizing.drop();
      listeners.current.onPointer(null);
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

  // Bare over the data, with a rim of the page's colour to stay legible on any of it.
  const control = 'flex size-7 items-center justify-center opacity-80 hover:opacity-100 [filter:drop-shadow(0_0_1.5px_var(--surface-background))_drop-shadow(0_0_1px_var(--surface-background))]';
  return (
    <div ref={room} className="relative h-full w-full overflow-hidden">
      {/* In its style, which the map library's own stylesheet cannot override. */}
      <div ref={container} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
      <div className="absolute start-1.5 top-1.5 flex flex-col">
        <button type="button" className={`${control} text-foreground`} aria-label={text.zoomIn} title={text.zoomIn} onClick={() => made.current?.zoomIn()}>
          <Icon name="add" className="size-4" />
        </button>
        <button type="button" className={`${control} text-foreground`} aria-label={text.zoomOut} title={text.zoomOut} onClick={() => made.current?.zoomOut()}>
          <Icon name="subtract" className="size-4" />
        </button>
        <button type="button" className={`${control} text-[var(--status-error)]`} aria-label={text.whole} title={text.whole} onClick={() => made.current?.fitBounds(bounds, { padding: 24 })}>
          <Icon name="focus-3" className="size-4" />
        </button>
      </div>
    </div>
  );
};

export default GeoMap;
