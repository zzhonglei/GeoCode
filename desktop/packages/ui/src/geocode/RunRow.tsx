import React from 'react';
import { create } from 'zustand';

import { MinDurationShineText } from '@/components/chat/message/parts/MinDurationShineText';
import { Icon } from '@/components/icon/Icon';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';

import type { Line, Tone } from './runLines';

// As the static tool rows draw theirs.
const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

const TONES = {
  plain: undefined,
  command: 'text-foreground',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
  success: 'text-[var(--status-success)]',
} as const satisfies Record<Tone, string | undefined>;

const ICONS = {
  plain: undefined,
  command: undefined,
  warning: 'error-warning',
  error: 'close-circle',
  success: 'check',
} as const satisfies Record<Tone, string | undefined>;

// A store rather than component state: the row moves between groups as the turn goes on, and stays open.
const useExpanded = create<{
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}>()((set) => ({
  open: new Set(),
  toggle: (id) =>
    set((state) => {
      const open = new Set(state.open);
      if (!open.delete(id)) open.add(id);
      return { open };
    }),
}));

/** How long a percentage takes to count up to a new value. */
const COUNT_MS = 600;

/**
 * A percentage counted up to each new value over a moment, from 0 when it first shows, rather than jumping: the run
 * reports its share done in steps. A new `doing`, or a share that went back, shows at once.
 */
const useCounted = (target: number | undefined, doing: string | undefined) => {
  const [shown, setShown] = React.useState(target);
  const from = React.useRef<{ readonly doing?: string; value?: number }>({ doing, value: target });
  // Before the row is painted, so a new `doing` never shows beside the share of the one before.
  React.useLayoutEffect(() => {
    const begin = from.current.doing === doing ? (from.current.value ?? 0) : undefined;
    from.current = { doing, value: target };
    if (target === undefined || begin === undefined || target <= begin) {
      setShown(target);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const step = () => {
      const done = Math.min(1, (performance.now() - started) / COUNT_MS);
      // Fast, then settling: as a count-up eases into its value.
      const value = Math.round(begin + (target - begin) * (1 - (1 - done) ** 3));
      from.current.value = value;
      setShown(value);
      if (done < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, doing]);
  return shown;
};

const Elapsed: React.FC<{ start: number; end: number | undefined }> = ({ start, end }) => {
  const now = useDurationTickerNow(end === undefined, 250);
  // As the shell's row counts.
  const elapsed = Math.max(0, (end ?? now) - start) / 1000;
  return <>{`${(elapsed < 0.05 && end !== undefined ? 0.1 : elapsed).toFixed(1)}s`}</>;
};

/**
 * A run's lines, one each, following the end as they arrive unless the user has scrolled up; the run ends with the
 * lines that say how it ended, so those are followed to as well. Spaces are kept, as a table or a traceback aligns by
 * them.
 */
const Log: React.FC<{ lines: readonly Line[] }> = ({ lines }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
      }}
      className="max-h-60 min-w-0 overflow-x-hidden overflow-y-auto font-mono text-[length:var(--text-code)] leading-relaxed text-muted-foreground"
    >
      {lines.map((line, index) => {
        const icon = line.icon ? ICONS[line.tone] : undefined;
        return (
          <div key={index} className={cn('min-w-0 overflow-hidden text-ellipsis whitespace-pre', TONES[line.tone])}>
            {icon ? <Icon name={icon} className="mr-1.5 inline-block size-3.5 align-[-2px]" /> : null}
            {line.text}
          </div>
        );
      })}
    </div>
  );
};

/**
 * A run of a geo tool, as one row: its logo and what GeoAgent says the step is for; while it runs, what it is doing,
 * its percentage when known, and the time so far; once done, the time it took, the title in the error colour when
 * `bad`. It opens to the run's lines.
 */
export const RunRow: React.FC<{
  id: string;
  logo: React.ReactNode;
  title: string;
  bad: boolean;
  doing?: string;
  percent?: number;
  start?: number;
  end?: number;
  lines: readonly Line[];
}> = ({ id, logo, title, bad, doing, percent, start, end, lines }) => {
  const counted = useCounted(percent, doing);
  const open = useExpanded((state) => state.open.has(id));
  const toggleOpen = useExpanded((state) => state.toggle);
  const toggle = () => toggleOpen(id);

  return (
    <div className="w-full min-w-0">
      <div
        className="group/tool oc-static-tool-row flex w-full min-w-0 cursor-pointer items-center gap-x-1.5 rounded-xl py-1.5 pr-2 pl-px"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        }}
      >
        <div className="relative h-5 w-3.5 flex-shrink-0">
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center transition-opacity',
              open ? 'opacity-0' : 'group-hover/tool:opacity-0',
            )}
          >
            {logo}
          </div>
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center transition-opacity',
              open ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
            )}
          >
            <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
          </div>
        </div>
        <span
          className={cn(
            'typography-meta max-w-[60%] flex-shrink-0 truncate whitespace-nowrap font-medium',
            ROW_TEXT_CLASS,
          )}
          style={{
            color: bad ? 'var(--status-error)' : 'var(--tools-title)',
          }}
          title={title}
        >
          {title}
        </span>
        <span className="min-w-0 flex-1">
          {doing ? (
            <MinDurationShineText
              active
              className={cn('typography-meta block min-w-0 truncate whitespace-nowrap', ROW_TEXT_CLASS)}
              style={{ color: 'var(--tools-description)' }}
            >
              {doing}
            </MinDurationShineText>
          ) : null}
        </span>
        <span className={cn('flex flex-shrink-0 gap-2 tabular-nums text-muted-foreground/80', ROW_TEXT_CLASS)}>
          {counted !== undefined ? <span className="text-foreground">{counted}%</span> : null}
          {start !== undefined ? (
            <span>
              <Elapsed start={start} end={end} />
            </span>
          ) : null}
        </span>
      </div>
      {open && lines.length ? (
        <div className="relative ml-2 min-w-0 pl-3">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-px bottom-0 left-0 w-px"
            style={{ backgroundColor: 'var(--tools-border)' }}
          />
          <div className="min-w-0 py-2 pr-2 pl-4">
            <Log lines={lines} />
          </div>
        </div>
      ) : null}
    </div>
  );
};
