import React from 'react';
import { Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { Icon } from '@/components/icon/Icon';
import type { BasemapText } from './basemapText';
import type { BasemapFault } from './geoStatus';

/**
 * The world the preview shows, 72°N to 56°S: beyond, there is only polar ice, which the projection stretches. The
 * preview's box has its shape in the map's projection (`aspect-[2075/1000]` below); change both together.
 */
const WORLD: [[number, number], [number, number]] = [[-180, -56], [180, 72]];

/**
 * The basemap as it draws the whole world, still: it cannot be dragged or zoomed. Its box keeps the world's shape whatever
 * the state, and what is wrong is laid over it. `onFailed` is told of a style none of whose tiles could be loaded: one
 * tile timing out among many that came is no reason to call the basemap broken.
 */
export const BasemapPreview: React.FC<{
  style: StyleSpecification | null | undefined;
  none: boolean;
  name: string | undefined;
  fault: BasemapFault | undefined;
  why: string | undefined;
  pending: boolean;
  text: BasemapText;
  onFailed: (style: StyleSpecification) => void;
}> = ({ style, none, name, fault, why, pending, text, onFailed }) => {
  const container = React.useRef<HTMLDivElement>(null);
  const failing = React.useRef(onFailed);
  React.useEffect(() => {
    failing.current = onFailed;
  });

  React.useEffect(() => {
    const within = container.current;
    if (!within || !style) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: within,
        style,
        bounds: WORLD,
        fitBoundsOptions: { padding: 0 },
        interactive: false,
        renderWorldCopies: false,
        attributionControl: { compact: false },
        // Sized below, and fitted to the world again with it.
        trackResize: false,
      });
    } catch {
      // Without WebGL there is no map to draw; the settings still work.
      return;
    }
    // A source's tiles, loaded or not; an icon missing leaves the map drawn, and MapLibre keeps requests it gives up to
    // itself. Judged once every request has settled.
    let loaded = false;
    let failed = false;
    map.on('data', (event) => {
      if (event.dataType === 'source' && 'tile' in event) loaded = true;
    });
    map.on('error', (event) => {
      if ('sourceId' in event) failed = true;
    });
    map.on('idle', () => {
      if (failed && !loaded) failing.current(style);
    });
    const sized = new ResizeObserver(() => {
      map.resize();
      map.fitBounds(WORLD, { padding: 0, duration: 0 });
      // Drawn at once: a canvas is blank from being sized until it is next drawn.
      map.redraw();
    });
    sized.observe(within);
    return () => {
      sized.disconnect();
      map.remove();
    };
  }, [style]);

  return (
    <div>
      <div className="relative aspect-[2075/1000] overflow-hidden rounded-xl bg-[var(--surface-muted)]">
        {/* Always there, so the map in it lives as long as its style; no basemap is laid over it. MapLibre makes its
            container `relative`, so the box that fills the preview is another, around it. */}
        <div className="absolute inset-0">
          <div ref={container} className="size-full" />
        </div>
        {none ? (
          <div
            aria-hidden
            className="absolute inset-0 bg-[var(--surface-muted)] bg-[radial-gradient(var(--interactive-border-hover)_1px,transparent_1px)] [background-size:16px_16px]"
          />
        ) : null}
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-[var(--interactive-border)]" />
        {name ? (
          <span className="typography-micro absolute start-2.5 top-2.5 max-w-[calc(100%-20px)] truncate rounded-full bg-[var(--surface-background)]/90 px-2.5 py-0.5 font-semibold text-foreground shadow-sm">
            {name}
          </span>
        ) : null}
        {pending ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-[var(--surface-background)] shadow-sm">
              <Icon name="loader-4" className="size-4 animate-spin text-[var(--status-warning)]" aria-hidden />
            </span>
          </div>
        ) : fault ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-background)]/55 p-4 backdrop-blur-[1.5px]">
            <span className="typography-meta flex max-w-full items-center gap-2 rounded-full bg-[var(--surface-background)] px-3 py-1.5 text-foreground shadow-sm">
              <Icon name="error-warning" className="size-4 shrink-0 text-[var(--status-error)]" aria-hidden />
              <span className="truncate">{text.veil[fault]}</span>
            </span>
          </div>
        ) : null}
      </div>
      {/* Two lines' room whatever it says, so a reason appearing moves nothing. */}
      <p className="typography-meta mt-2 line-clamp-2 h-9 leading-[18px] text-[var(--status-error)]" title={why}>{why}</p>
    </div>
  );
};
