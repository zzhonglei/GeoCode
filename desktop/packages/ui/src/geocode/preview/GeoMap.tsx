import React from 'react';
import { addProtocol, Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { Icon } from '@/components/icon/Icon';
import { ContentLoadingState } from '@/components/ui/content-state';
import { useI18n } from '@/lib/i18n';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { colorOf, EDGE, MARK, MARK_EDGE } from './geoColors';
import { previewText } from './previewText';
import { stilled } from './stilled';
import { identifyGeoFeature, readGeoPixel, refusalCode, FORMS, tileAddress, tileRequestPath, TILE_SCHEME, type FoundFeature, type FoundPixel, type GeoBounds, type GeoDescription, type GeoLook, type Form, type Target } from './previewClient';

/**
 * Where a map was last looked at, kept while its tab is hidden and the map itself is not, and from one layer of a
 * file to the next. `whole` says that it showed the whole of its data, which the map that follows it then does at
 * its own size.
 */
export type MapView = { center: [number, number]; zoom: number; whole: boolean };

// A raster's tile is an image 512 pixels wide drawn 256 wide, so it is sharp on a display of twice the density.
const RASTER_TILE = 256;
// Half the side of the map's plane, in metres.
const HALF = 20037508.342789244;
// How near a click must be to a feature to pick it, in pixels.
const PICK_RADIUS = 5;
// The deepest tiles asked of a vector layer; deeper, the map draws these larger. Their vertices sit a pixel apart at
// the deepest the map zooms.
const VECTOR_DEPTH = 20;
// How long the map takes back to where the whole of the data shows, in milliseconds.
const BACK = 500;
// The deepest a feature is zoomed to: a point has no size to fit the map to.
const REACH_DEPTH = 17;
// The map's layers that draw each of a vector layer's forms.
const DRAWN_AS = { points: ['point'], lines: ['line', 'small-line'], polygons: ['fill', 'outline', 'thin-polygon', 'small-polygon'] } satisfies Record<Form, readonly string[]>;

const show = (map: MapLibreMap, shown: readonly Form[]) => {
  for (const form of FORMS) {
    for (const layer of DRAWN_AS[form]) map.setLayoutProperty(layer, 'visibility', shown.includes(form) ? 'visible' : 'none');
  }
};

/**
 * Draws a raster from these tiles, as the `order`th drawing of it, over those before it, which go once this one is
 * whole: taken away first, they would leave the map blank until its tiles came. `latest` says which drawing is the
 * last, by then.
 */
const drawRaster = (map: MapLibreMap, order: number, tiles: string, resolution: number | null, bounds: GeoBounds, latest: () => number) => {
  const id = `raster-${order}`;
  map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: RASTER_TILE, bounds, maxzoom: nativeZoom(resolution) });
  // Under the mark of the pixel that is clicked, where there is one.
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 0 } }, map.getLayer('pixel-edge') ? 'pixel-edge' : undefined);
  map.once('idle', () => {
    for (const layer of map.getStyle().layers) {
      if (layer.type !== 'raster' || layer.id === `raster-${latest()}`) continue;
      map.removeLayer(layer.id);
      map.removeSource(layer.id);
    }
  });
};

/** Marks the pixel of these corners over the raster: its edge, and a dot at its middle for where it is too small to see. */
const markPixel = (map: MapLibreMap, corners: readonly (readonly [number, number])[] | null) => {
  for (const layer of ['pixel-edge', 'pixel-dot']) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  if (map.getSource('pixel')) map.removeSource('pixel');
  if (corners === null || corners.length === 0) return;
  const ring = [...corners, corners[0]].map(([longitude, latitude]) => [longitude, latitude]);
  const middle = [0, 1].map((part) => corners.reduce((sum, corner) => sum + corner[part], 0) / corners.length);
  map.addSource('pixel', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: middle } },
      ],
    },
  });
  map.addLayer({ id: 'pixel-edge', type: 'line', source: 'pixel', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': MARK_EDGE, 'line-width': 2 } });
  map.addLayer({ id: 'pixel-dot', type: 'circle', source: 'pixel', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': MARK, 'circle-radius': 3, 'circle-stroke-color': MARK_EDGE, 'circle-stroke-width': 1.5 } });
};

/** Marks the one feature these tiles are of, over all the map draws; nothing with no tiles. */
const mark = (map: MapLibreMap, tiles: string | null) => {
  for (const layer of map.getStyle().layers) {
    if ('source' in layer && layer.source === 'mark') map.removeLayer(layer.id);
  }
  if (map.getSource('mark')) map.removeSource('mark');
  if (tiles === null) return;
  map.addSource('mark', { type: 'vector', tiles: [tiles], maxzoom: VECTOR_DEPTH });
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
  map.addLayer({ id: 'mark-fill', type: 'fill', source: 'mark', 'source-layer': 'polygons', paint: { 'fill-color': MARK, 'fill-opacity': 0.85 } });
  map.addLayer({ id: 'mark-outline', type: 'line', source: 'mark', 'source-layer': 'polygons', layout: round, paint: { 'line-color': MARK_EDGE, 'line-width': 2.5 } });
  // A line, and a polygon too thin at this zoom to have an inside.
  for (const lines of ['lines', 'thin-polygons']) {
    map.addLayer({ id: `mark-${lines}-edge`, type: 'line', source: 'mark', 'source-layer': lines, layout: round, paint: { 'line-color': MARK_EDGE, 'line-width': 5.5 } });
    map.addLayer({ id: `mark-${lines}`, type: 'line', source: 'mark', 'source-layer': lines, layout: round, paint: { 'line-color': MARK, 'line-width': 2.5 } });
  }
  // A point, and a line or a polygon too small at this zoom to be seen as one.
  for (const dots of ['points', 'small-lines', 'small-polygons']) {
    map.addLayer({ id: `mark-${dots}`, type: 'circle', source: 'mark', 'source-layer': dots, paint: { 'circle-color': MARK, 'circle-radius': 5, 'circle-stroke-color': MARK_EDGE, 'circle-stroke-width': 2 } });
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

/**
 * The deepest zoom at which a tile still shows no more pixels than the raster has there, of pixels `resolution` metres
 * of the map's plane wide; the map's own deepest where the reader could not say how wide they are.
 */
const nativeZoom = (resolution: number | null): number =>
  resolution === null ? 22 : Math.max(0, Math.min(22, Math.ceil(Math.log2((2 * HALF) / (resolution * RASTER_TILE * 2)))));

const GeoMap: React.FC<{
  target: Target;
  description: GeoDescription;
  /** Where the data lies; a dataset with no place on the map gets no map. */
  bounds: GeoBounds;
  /** Those of a vector layer's points, lines and polygons that are drawn, and so can be clicked. */
  shown: readonly Form[];
  /** The number of the feature that is picked, which the map marks. */
  marked: number | null;
  /** How a raster is drawn, none while that is left to the reader. */
  look: GeoLook | null;
  /** The pixel of a raster that is clicked, which the map marks. */
  pixel: FoundPixel | null;
  /** A raster was clicked: the pixel under the click, or none where the raster does not reach. */
  onPixel: (found: FoundPixel | null) => void;
  /** Read when the map is made and written when it goes. */
  view: React.MutableRefObject<MapView | null>;
  /** Holds, for as long as there is a map, what moves it to where a feature lies. */
  reach: React.MutableRefObject<((to: GeoBounds) => void) | null>;
  onPick: (found: FoundFeature | null) => void;
  /** Where the pointer is over the map, as a longitude and a latitude, or that it has left. */
  onPointer: (at: readonly [number, number] | null) => void;
  /** A tile was refused, with the code it was refused with. */
  onRefused: (code: string) => void;
  /** What a click was to find could not be read, with the code it was refused with. */
  onMissed: (code: string) => void;
  /** The map could not be made at all, as on a computer without WebGL. */
  onFailed: () => void;
}> = ({ target, description, bounds, shown, marked, look, pixel, view, reach, onPick, onPixel, onPointer, onRefused, onMissed, onFailed }) => {
  const { locale } = useI18n();
  const text = previewText(locale);
  // The room the map is given, and within it the map itself, which keeps the size it was last drawn at.
  const room = React.useRef<HTMLDivElement>(null);
  const container = React.useRef<HTMLDivElement>(null);
  const made = React.useRef<MapLibreMap | null>(null);
  // Holds, for as long as there is a map, what sends it back to where the whole of the data shows.
  const back = React.useRef<(() => void) | null>(null);
  // The map is made once for the data it shows; what it tells goes to whoever listens now, and a click looks among
  // what is shown now.
  const listeners = React.useRef({ onPick, onPixel, onPointer, onRefused, onMissed, onFailed });
  const showing = React.useRef(shown);
  const marking = React.useRef(marked);
  const looking = React.useRef(look);
  const pointing = React.useRef(pixel);
  // How many times the map there is has drawn its raster.
  const rasters = React.useRef(0);
  // The data the map has drawn its first view of. Until then it is blank, there being nothing under the data: a large
  // vector layer is read into memory for its first tiles, which takes seconds, and is refused at the end of them when
  // it is too large to draw.
  const [drawn, setDrawn] = React.useState<GeoDescription | null>(null);
  React.useEffect(() => {
    listeners.current = { onPick, onPixel, onPointer, onRefused, onMissed, onFailed };
    showing.current = shown;
    pointing.current = pixel;
    marking.current = marked;
    looking.current = look;
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
    const before = view.current;
    rasters.current = 0;
    const tiles = tileAddress(target, description.stamp);
    const beginning = tiles.slice(0, tiles.indexOf('&z='));
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: within,
        style: { version: 8, sources: {}, layers: [] },
        ...(before && !before.whole ? { center: before.center, zoom: before.zoom } : { bounds, fitBoundsOptions: { padding: 24 } }),
        attributionControl: false,
        // Sized below, once its room has stopped changing: drawn whole again for every frame of a panel sliding,
        // it would make the slide drop frames. Meanwhile it stays as it was drawn, centred in its room, whose moving
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
    reach.current = (to) => map.fitBounds(to, { padding: 48, maxZoom: REACH_DEPTH });
    // Whether the map shows the whole of the data: as it is made, unless it is made where another was looked at,
    // and until it is next moved. While it does, it is fitted again to each size it is given: the panel under it
    // opens at a click and takes a third of its room, and the whole of the data fitted to the room before would
    // then be cut off, and not be where the button that shows all of it leads.
    let whole = !before || before.whole;
    // In `moving` milliseconds; at once when its size has changed, which is no move to follow.
    const fitWhole = (moving: number) => {
      map.fitBounds(bounds, { padding: 24, duration: moving });
      whole = true;
    };
    back.current = () => fitWhole(BACK);
    map.on('movestart', () => {
      whole = false;
    });
    const sizing = stilled(() => {
      if (within.clientWidth === around.clientWidth && within.clientHeight === around.clientHeight) return;
      // Asked before the map is sized, which counts as a move.
      const fitted = whole;
      fit();
      map.resize();
      if (fitted) fitWhole(0);
      // Drawn at once: a canvas is blank from being sized until it is next drawn, which shows as a flicker.
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
      // Once the tiles of the first view are in, whether drawn or refused.
      map.once('idle', () => setDrawn(description));
      if (description.kind === 'raster') {
        rasters.current = 1;
        drawRaster(map, 1, tileAddress(target, description.stamp, { look: looking.current }), description.resolution ?? null, bounds, () => rasters.current);
        markPixel(map, pointing.current?.outline ?? null);
        map.on('click', (event) => {
          const click = (clicks += 1);
          const at = MercatorCoordinate.fromLngLat(event.lngLat.wrap());
          void readGeoPixel(target, description.stamp, { x: (at.x * 2 - 1) * HALF, y: (1 - at.y * 2) * HALF }).then((outcome) => {
            // A click answered after a later one says nothing any more.
            if (click !== clicks) return;
            if (outcome.ok) return listeners.current.onPixel(outcome.value);
            listeners.current.onPixel(null);
            listeners.current.onMissed(outcome.code);
          });
        });
        return;
      }
      // A vector tile's layers: polygons, lines and points as they are, and a dot for each line and polygon too small
      // to be seen as one at the tile's zoom.
      // Asked of every tile in view, not only those within the bounds: a file's own record of its extent may be out of
      // date, and what lies outside it would never be drawn.
      map.addSource('data', { type: 'vector', tiles: [tiles], maxzoom: VECTOR_DEPTH });
      const color = colorOf(description.layer);
      map.addLayer({ id: 'fill', type: 'fill', source: 'data', 'source-layer': 'polygons', paint: { 'fill-color': color, 'fill-opacity': 0.5 } });
      map.addLayer({ id: 'outline', type: 'line', source: 'data', 'source-layer': 'polygons', paint: { 'line-color': EDGE, 'line-width': 0.75 } });
      map.addLayer({ id: 'line', type: 'line', source: 'data', 'source-layer': 'lines', paint: { 'line-color': color, 'line-width': 1.5 } });
      map.addLayer({ id: 'thin-polygon', type: 'line', source: 'data', 'source-layer': 'thin-polygons', paint: { 'line-color': color, 'line-width': 1.5 } });
      map.addLayer({ id: 'small-polygon', type: 'circle', source: 'data', 'source-layer': 'small-polygons', paint: { 'circle-color': color, 'circle-radius': 1 } });
      map.addLayer({ id: 'small-line', type: 'circle', source: 'data', 'source-layer': 'small-lines', paint: { 'circle-color': color, 'circle-radius': 1 } });
      map.addLayer({ id: 'point', type: 'circle', source: 'data', 'source-layer': 'points', paint: { 'circle-color': color, 'circle-radius': 3.5, 'circle-stroke-color': EDGE, 'circle-stroke-width': 0.75 } });
      show(map, showing.current);
      mark(map, marking.current === null ? null : tileAddress(target, description.stamp, { fid: marking.current }));
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
          listeners.current.onMissed(outcome.code);
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
      reach.current = null;
      back.current = null;
      told.delete(tell);
      if (told.size === 0) refusals.delete(beginning);
      const center = map.getCenter();
      view.current = { center: [center.lng, center.lat], zoom: map.getZoom(), whole };
      map.remove();
    };
  }, [target, description, bounds, view, reach]);

  React.useEffect(() => {
    // Before the map has its layers, they are shown as asked when it gets them.
    if (made.current?.getLayer('point')) show(made.current, shown);
  }, [shown]);

  React.useEffect(() => {
    // As above: marked when the map gets its layers, where it has none yet.
    if (made.current?.getLayer('point')) mark(made.current, marked === null ? null : tileAddress(target, description.stamp, { fid: marked }));
  }, [marked, target, description.stamp]);

  React.useEffect(() => {
    // As above, of a map that has drawn no raster yet.
    if (made.current && rasters.current > 0) markPixel(made.current, pixel?.outline ?? null);
  }, [pixel]);

  React.useEffect(() => {
    // As above: a map that has drawn no raster yet draws it as asked when it does.
    if (!made.current || description.kind !== 'raster' || rasters.current === 0) return;
    rasters.current += 1;
    drawRaster(made.current, rasters.current, tileAddress(target, description.stamp, { look }), description.resolution ?? null, bounds, () => rasters.current);
  }, [look, target, description, bounds]);

  // Bare over the data, with a rim of the page's colour to stay legible on any of it.
  const control = 'flex size-7 items-center justify-center opacity-80 hover:opacity-100 [filter:drop-shadow(0_0_1.5px_var(--surface-background))_drop-shadow(0_0_1px_var(--surface-background))]';
  return (
    <div ref={room} className="relative h-full w-full overflow-hidden">
      {/* In its style, which the map library's own stylesheet cannot override. */}
      <div ref={container} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />
      {drawn !== description ? <ContentLoadingState label={text.reading} className="pointer-events-none absolute inset-0" /> : null}
      <div className="absolute start-1.5 top-1.5 flex flex-col">
        <button type="button" className={`${control} text-foreground`} aria-label={text.zoomIn} title={text.zoomIn} onClick={() => made.current?.zoomIn()}>
          <Icon name="add" className="size-4" />
        </button>
        <button type="button" className={`${control} text-foreground`} aria-label={text.zoomOut} title={text.zoomOut} onClick={() => made.current?.zoomOut()}>
          <Icon name="subtract" className="size-4" />
        </button>
        <button type="button" className={`${control} text-[var(--status-error)]`} aria-label={text.whole} title={text.whole} onClick={() => back.current?.()}>
          <Icon name="focus-3" className="size-4" />
        </button>
      </div>
    </div>
  );
};

export default GeoMap;
