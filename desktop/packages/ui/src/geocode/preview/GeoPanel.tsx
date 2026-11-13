import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { PreviewText } from './previewText';

export type PanelTab = { id: string; label: string; content: React.ReactNode };

// The panel's height over the bottom of the map, in pixels: as it opens, and the least it is dragged to.
const HEIGHT = 280;
const LEAST = 120;
// What a drag leaves of the map above the panel, in pixels.
const MAP_LEAST = 160;
// Its width over the right of the map.
const WIDTH = 340;

/**
 * What goes with the map, a tab at a time. It lies over the map, never beside it, so the map keeps its size as it
 * opens and closes: along the map's bottom in a room taller than wide, as the app's side panel mostly is, where its
 * strip is dragged to size it; along the map's right where `beside` says the room is wide. It slides in from that edge
 * and out to it as the app's panels move. `room` is the map's height.
 */
export const GeoPanel: React.FC<{
  tabs: readonly PanelTab[];
  active: string;
  open: boolean;
  beside: boolean;
  room: number;
  text: PreviewText;
  onActive: (id: string) => void;
  onOpen: (open: boolean) => void;
}> = ({ tabs, active, open, beside, room, text, onActive, onOpen }) => {
  const [height, setHeight] = React.useState(HEIGHT);
  const drag = React.useRef<{ from: number; height: number } | null>(null);
  const drop = () => {
    drag.current = null;
  };
  // What a tab shows stays while the panel slides out and goes once it is out of sight: a closed panel reads nothing,
  // as its table would page after page.
  const [leaving, setLeaving] = React.useState(false);
  const [was, setWas] = React.useState(open);
  if (was !== open) {
    setWas(open);
    setLeaving(!open);
  }
  // Moved to the other edge as the room changed, an open panel fades in there: sliding out at one edge and in at the
  // other would take twice as long as the app's own layout just did.
  const [edge, setEdge] = React.useState(beside);
  const [arriving, setArriving] = React.useState(false);
  if (edge !== beside) {
    setEdge(beside);
    setArriving(open);
  }
  React.useEffect(() => {
    if (!arriving) return;
    // A frame after it was drawn unseen, so that it fades from there.
    const frame = requestAnimationFrame(() => setArriving(false));
    return () => cancelAnimationFrame(frame);
  }, [arriving]);
  const shown = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!shown) return null;
  const tall = Math.max(LEAST, Math.min(height, room - MAP_LEAST));

  const strip = (
    <div
      className={cn('relative flex h-9 shrink-0 items-center gap-1 border-b border-edge-muted bg-[var(--surface-subtle)] px-2', !beside && 'cursor-row-resize touch-none')}
      onPointerDown={(event) => {
        // The strip itself, not a button on it, and with the button that drags.
        if (beside || event.button !== 0 || event.target !== event.currentTarget) return;
        drag.current = { from: event.clientY, height: tall };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const wanted = drag.current.height + drag.current.from - event.clientY;
        setHeight(Math.max(LEAST, Math.min(wanted, room - MAP_LEAST)));
      }}
      onPointerUp={drop}
      onPointerCancel={drop}
      onLostPointerCapture={drop}
    >
      {beside ? null : <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[3px] h-[3px] w-9 -translate-x-1/2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]" />}
      {tabs.map((tab) => {
        const current = tab.id === shown.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={current}
            className={cn('h-[26px] rounded-md px-3 typography-meta', current ? 'oc-raised bg-[var(--surface-background)] font-medium text-foreground dark:bg-surface-elevated' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => onActive(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
      <div className="pointer-events-none flex-1" />
      <button
        type="button"
        className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        aria-label={text.closePanel}
        title={text.closePanel}
        onClick={() => onOpen(false)}
      >
        <Icon name="close" className="size-4" />
      </button>
    </div>
  );

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'absolute z-10 flex flex-col bg-background shadow-md transition-[translate,opacity] duration-[var(--oc-motion-layout-duration)] ease-[var(--oc-motion-layout-easing)]',
        beside ? 'inset-y-0 end-0 border-s border-edge-muted' : 'inset-x-0 bottom-0 border-t border-edge-muted',
        !open && 'pointer-events-none opacity-0',
        !open && (beside ? 'translate-x-full' : 'translate-y-full'),
        arriving && 'opacity-0 transition-none',
      )}
      style={beside ? { width: WIDTH } : { height: tall }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setLeaving(false);
      }}
    >
      {strip}
      <div className="min-h-0 flex-1">{open || leaving ? shown.content : null}</div>
    </div>
  );
};
