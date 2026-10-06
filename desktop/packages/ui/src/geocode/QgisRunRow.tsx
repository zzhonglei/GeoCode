import React from 'react';
import { create } from 'zustand';

import { MinDurationShineText } from '@/components/chat/message/parts/MinDurationShineText';
import { Icon } from '@/components/icon/Icon';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18nStore } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

import { qgisRunning } from './geoTools';
import { type Line, type Tone, qgisRunView } from './qgisRun';
import { QgisLogo } from './QgisLogo';

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

const Elapsed: React.FC<{ start: number; end: number | undefined }> = ({ start, end }) => {
  const now = useDurationTickerNow(end === undefined, 250);
  // As the shell's row counts.
  const elapsed = Math.max(0, (end ?? now) - start) / 1000;
  return <>{`${(elapsed < 0.05 && end !== undefined ? 0.1 : elapsed).toFixed(1)}s`}</>;
};

/**
 * The excerpt of the answer, a line each, following its end as lines arrive unless the user has scrolled up; the end of
 * the run arrives with the lines that say how it ended, so those are followed to as well.
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
          <div key={index} className={cn('min-w-0 truncate whitespace-nowrap', TONES[line.tone])}>
            {icon ? <Icon name={icon} className="mr-1.5 inline-block size-3.5 align-[-2px]" /> : null}
            {line.text}
          </div>
        );
      })}
    </div>
  );
};

/**
 * A qgisrun call's row: the QGIS logo and what GeoAgent says the step is for; while it runs, the algorithm being run,
 * its percentage when QGIS reports one, and the time so far; once done, the time it took, the title in the error
 * colour unless it finished. It opens to the English excerpt of the answer: the facts settled before the run, every
 * message QGIS gave, and how the run ended.
 */
export const QgisRunRow: React.FC<{ part: ToolPart }> = ({ part }) => {
  // Subscribed so the row follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  const open = useExpanded((state) => state.open.has(part.id));
  const toggleOpen = useExpanded((state) => state.toggle);
  const view = qgisRunView(part, locale);
  const toggle = () => toggleOpen(part.id);

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
            <QgisLogo className="h-3.5 w-3.5" />
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
            color: view.bad ? 'var(--status-error)' : 'var(--tools-title)',
          }}
          title={view.title}
        >
          {view.title}
        </span>
        <span className="min-w-0 flex-1">
          {view.running && view.algorithm ? (
            <MinDurationShineText
              active
              className={cn('typography-meta block min-w-0 truncate whitespace-nowrap', ROW_TEXT_CLASS)}
              style={{ color: 'var(--tools-description)' }}
            >
              {qgisRunning(view.algorithm.name, locale)}
            </MinDurationShineText>
          ) : null}
        </span>
        <span className={cn('flex flex-shrink-0 gap-2 tabular-nums text-muted-foreground/80', ROW_TEXT_CLASS)}>
          {view.percent !== undefined ? <span className="text-foreground">{view.percent}%</span> : null}
          {view.start !== undefined ? (
            <span>
              <Elapsed start={view.start} end={view.end} />
            </span>
          ) : null}
        </span>
      </div>
      {open && view.lines.length ? (
        <div className="relative ml-2 min-w-0 pl-3">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-px bottom-0 left-0 w-px"
            style={{ backgroundColor: 'var(--tools-border)' }}
          />
          <div className="min-w-0 py-2 pr-2 pl-4">
            <Log lines={view.lines} />
          </div>
        </div>
      ) : null}
    </div>
  );
};
