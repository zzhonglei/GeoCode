import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { holdLayoutAnimation } from '@/lib/layoutAnimation';
import { cn } from '@/lib/utils';
import type { PreviewText } from './previewText';

export type PanelTab = { id: string; label: string; content: React.ReactNode };

// The panel's height under the map, in pixels: as it opens, and the least it is dragged to.
const HEIGHT = 280;
const LEAST = 120;
// What a drag leaves the map and the strip of tabs together, in pixels.
const MAP_LEAST = 160;
// Its width beside the map.
const WIDTH = 340;

/**
 * What goes with the map, a tab at a time: under it in a panel taller than wide, as the app's side panel mostly is,
 * where its strip of tabs stays when it is closed and is dragged to size it; beside it where `beside` says the room
 * is wide, and gone when closed there. `room` is the height the map and the panel share.
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
  // `release` ends the hold a drag puts on what follows the layout, the map among it: sized on every frame of the
  // drag, it made the drag stutter.
  const drag = React.useRef<{ from: number; height: number; release: () => void } | null>(null);
  const drop = () => {
    drag.current?.release();
    drag.current = null;
  };
  // A hold never released would keep everything in the app that waits for the layout to settle waiting for good, and
  // the end of a drag does not always arrive: a menu may open over it, or the panel go while it is dragged.
  React.useEffect(() => () => drag.current?.release(), []);
  const shown = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!shown || (beside && !open)) return null;
  const tall = Math.max(LEAST, Math.min(height, room - MAP_LEAST));

  const strip = (
    <div
      className={cn('relative flex h-9 shrink-0 items-center gap-1 bg-[var(--surface-subtle)] px-2', beside ? 'border-b border-edge-muted' : 'touch-none border-t border-edge-muted', !beside && open && 'cursor-row-resize')}
      onPointerDown={(event) => {
        // The strip itself, not a button on it, and with the button that drags.
        if (beside || !open || event.button !== 0 || event.target !== event.currentTarget) return;
        drop();
        drag.current = { from: event.clientY, height: tall, release: holdLayoutAnimation('height') };
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
        const current = open && tab.id === shown.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={current}
            className={cn('h-[26px] rounded-md px-3 typography-meta', current ? 'oc-raised bg-[var(--surface-background)] font-medium text-foreground dark:bg-surface-elevated' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => {
              onActive(tab.id);
              onOpen(true);
            }}
          >
            {tab.label}
          </button>
        );
      })}
      <div className="pointer-events-none flex-1" />
      <button
        type="button"
        className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        aria-label={open ? text.closePanel : text.openPanel}
        title={open ? text.closePanel : text.openPanel}
        onClick={() => onOpen(!open)}
      >
        <Icon name={beside ? 'arrow-right-s' : open ? 'arrow-down-s' : 'arrow-up-s'} className="size-4" />
      </button>
    </div>
  );

  if (beside) {
    return (
      <div className="flex min-h-0 shrink-0 flex-col border-s border-edge-muted bg-background" style={{ width: WIDTH }}>
        {strip}
        <div className="min-h-0 flex-1">{shown.content}</div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col bg-background">
      {strip}
      {open ? (
        <div className="min-h-0 border-t border-edge-muted" style={{ height: tall }}>
          {shown.content}
        </div>
      ) : null}
    </div>
  );
};
