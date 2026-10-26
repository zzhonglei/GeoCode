import React from 'react';

import { MinDurationShineText } from '@/components/chat/message/parts/MinDurationShineText';
import { ToolRevealOnMount } from '@/components/chat/message/parts/ToolRevealOnMount';
import { Icon } from '@/components/icon/Icon';
import { Text } from '@/components/ui/text';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18nStore } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

import { OsmLogo } from './OsmLogo';
import { osmText } from './osmText';
import {
  type Candidate,
  type Counts,
  type FileCard,
  type Note,
  osmDownloadView,
  osmProbeView,
  osmSearchView,
  type StepRow,
} from './osmView';
import { RunRow } from './RunRow';
import { useRunRowOpen, useRunRowToggle } from './runRowOpen';
import { Slide } from './Slide';

// As the static tool rows draw theirs.
const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

/** Candidates shown before the rest are folded away. */
const SHOWN_CANDIDATES = 5;

/** What an OSM object was mapped as: a dot, a line or an outline. */
const GeometryMark: React.FC<{ kind: 'point' | 'line' | 'area'; label: string; className?: string }> = ({
  kind,
  label,
  className,
}) => (
  <svg
    viewBox="0 0 16 16"
    role="img"
    aria-label={label}
    className={cn('size-3.5 flex-shrink-0 text-muted-foreground', className)}
  >
    <title>{label}</title>
    {kind === 'point' ? <circle cx="8" cy="8" r="3.2" fill="currentColor" /> : null}
    {kind === 'line' ? (
      <path
        d="M2 12.5 L6 6.5 L10 9.5 L14 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    ) : null}
    {kind === 'area' ? (
      <path
        d="M3 5 L9 2.5 L14 7 L12 13.5 L4 12.5 Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    ) : null}
  </svg>
);

/** The panel a row opens to, aligned with the row's title (docs/OSM.md, section 9). */
const Panel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1.5 ms-[21px] rounded-[10px] bg-[var(--surface-muted)] p-1.5 text-[length:var(--text-meta)] leading-normal">
    {children}
  </div>
);

const Divider = () => <div className="mx-1.5 my-1 h-px bg-border" />;

const NOTE_TONES = {
  info: { icon: 'information', className: 'text-muted-foreground' },
  warning: { icon: 'error-warning', className: 'text-[var(--status-warning)]' },
  error: { icon: 'close-circle', className: 'text-[var(--status-error)]' },
} as const;

const Notes: React.FC<{ notes: readonly Note[] }> = ({ notes }) => (
  <>
    {notes.map((note, index) => (
      <div key={index} className={cn('flex items-start gap-1.5 px-1.5 py-1', NOTE_TONES[note.tone].className)}>
        <Icon name={NOTE_TONES[note.tone].icon} className="mt-[3px] size-3.5 flex-shrink-0" />
        <div className="min-w-0">
          {note.text}
          {note.said ? (
            <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[length:var(--text-code)] text-muted-foreground">
              {note.said}
            </div>
          ) : null}
        </div>
      </div>
    ))}
  </>
);

/** A button that unfolds what was folded away. */
const More: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
  >
    <Icon name="arrow-down-s" className="size-3" />
    {label}
  </button>
);

const CandidateItem: React.FC<{ candidate: Candidate; kindLabel: string }> = ({ candidate, kindLabel }) => (
  <div
    className={cn(
      'flex min-w-0 gap-2 rounded-[7px] px-1.5 py-[5px] hover:bg-[var(--interactive-hover)]',
      candidate.transit && 'opacity-60',
    )}
  >
    <GeometryMark kind={candidate.kind} label={kindLabel} className="mt-0.5" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-[var(--tools-title)]">{candidate.name}</span>
        {candidate.nameEn ? (
          <span className="min-w-0 truncate text-muted-foreground/70">{candidate.nameEn}</span>
        ) : null}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {candidate.where ? `${candidate.what} · ${candidate.where}` : candidate.what}
      </div>
    </div>
    <div className="flex-shrink-0 text-end text-xs tabular-nums text-muted-foreground">
      {candidate.size ? <div>{candidate.size}</div> : null}
      <div className="font-mono text-[11.5px] text-muted-foreground/70">{candidate.id}</div>
    </div>
  </div>
);

const Candidates: React.FC<{
  candidates: readonly Candidate[];
  kinds: Record<Candidate['kind'], string>;
  more: (count: number) => string;
}> = ({ candidates, kinds, more }) => {
  const [all, setAll] = React.useState(false);
  const shown = all ? candidates : candidates.slice(0, SHOWN_CANDIDATES);
  return (
    <>
      {shown.map((candidate) => (
        <CandidateItem key={candidate.id} candidate={candidate} kindLabel={kinds[candidate.kind]} />
      ))}
      {shown.length < candidates.length ? (
        <More label={more(candidates.length - shown.length)} onClick={() => setAll(true)} />
      ) : null}
    </>
  );
};

const count = (value: number) => value.toLocaleString('en-US');

const CountBars: React.FC<{
  counts: Counts;
  noneHere: string;
  notCounted: string;
  more: (count: number) => string;
}> = ({ counts, noneHere, notCounted, more }) => {
  const [all, setAll] = React.useState(false);
  const longest = Math.max(1, ...counts.bars.map((bar) => bar.count));
  const bars = all ? counts.bars : counts.bars.slice(0, counts.shown);
  return (
    <div className="py-0.5">
      {counts.heading ? (
        <div className="px-1.5 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">{counts.heading}</div>
      ) : null}
      <div className="grid grid-cols-[minmax(0,max-content)_minmax(60px,1fr)_max-content] items-center gap-x-2.5 gap-y-px">
        {bars.map((bar) => (
          <React.Fragment key={bar.label}>
            <span className="min-w-0 truncate py-[3px] ps-1.5 font-mono text-[length:var(--text-code)] text-[var(--tools-title)]">
              {bar.label}
              {bar.chip ? (
                <span className="ms-1.5 rounded-full border border-border bg-background px-1.5 font-sans text-[11px] text-muted-foreground">
                  {bar.chip}
                </span>
              ) : null}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-border/60">
              <span
                className="block h-full rounded-full bg-muted-foreground/45"
                style={{ width: `${Math.max(2, (bar.count / longest) * 100)}%` }}
              />
            </span>
            <span className="pe-1.5 text-end tabular-nums text-[var(--tools-title)]">{count(bar.count)}</span>
          </React.Fragment>
        ))}
        {counts.rest ? (
          <>
            <span className="min-w-0 truncate py-[3px] ps-1.5 text-muted-foreground">{counts.rest.label}</span>
            <span />
            <span className="pe-1.5 text-end tabular-nums text-muted-foreground">{count(counts.rest.count)}</span>
          </>
        ) : null}
      </div>
      {bars.length < counts.bars.length ? (
        <More label={more(counts.bars.length - bars.length)} onClick={() => setAll(true)} />
      ) : null}
      {counts.zeros.length ? (
        <div className="px-1.5 pb-0.5 pt-1 text-xs text-muted-foreground">
          {noneHere}
          <span className="font-mono">{counts.zeros.join(', ')}</span>
        </div>
      ) : null}
      {counts.uncounted?.length ? (
        <div className="px-1.5 pb-0.5 pt-1 text-xs text-muted-foreground">
          {notCounted}
          <span className="font-mono">{counts.uncounted.join(', ')}</span>
        </div>
      ) : null}
      {counts.foot ? <div className="px-1.5 pb-0.5 pt-1 text-xs text-muted-foreground">{counts.foot}</div> : null}
    </div>
  );
};

const STEP_MARKS = {
  done: <Icon name="check" className="size-3.5 text-[var(--status-success)]" />,
  now: (
    <span className="size-2.5 animate-spin rounded-full border-[1.6px] border-border border-t-[var(--tools-title)] motion-reduce:animate-none" />
  ),
  later: <span className="size-1.5 rounded-full border border-border" />,
};

const Steps: React.FC<{ steps: readonly StepRow[] }> = ({ steps }) => (
  <div className="grid grid-cols-[14px_max-content_minmax(0,1fr)_max-content] items-center gap-x-2 gap-y-0.5 px-1.5 py-1">
    {steps.map((step) => (
      <React.Fragment key={step.step}>
        <span className="flex size-3.5 items-center justify-center">{STEP_MARKS[step.state]}</span>
        <span className={step.state === 'later' ? 'text-muted-foreground/70' : 'text-[var(--tools-title)]'}>
          {step.label}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {step.info ? <span className="truncate">{step.info}</span> : null}
          {step.share !== undefined ? (
            <span className="h-1 w-full max-w-40 overflow-hidden rounded-full bg-border/60">
              <span
                className="block h-full rounded-full bg-[var(--tools-title)] opacity-55 transition-[width] duration-500"
                style={{ width: `${step.share}%` }}
              />
            </span>
          ) : null}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground/70">{step.time ?? ''}</span>
        {step.warn ? (
          <span className="col-span-3 col-start-2 pb-0.5 text-xs text-[var(--status-warning)]">{step.warn}</span>
        ) : null}
      </React.Fragment>
    ))}
  </div>
);

/** The file a download wrote: its name and folder, each layer's features, how current the data is and its columns. */
const Written: React.FC<{ file: FileCard }> = ({ file }) => (
  <>
    <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
      <Icon name="stack" className="size-3.5 flex-shrink-0 text-[var(--tools-icon)]" />
      <span className="flex-shrink-0 font-medium text-[var(--tools-title)]">{file.name}</span>
      <span className="min-w-0 truncate text-muted-foreground/70">{file.folder}</span>
    </div>
    <div className="flex flex-wrap gap-1.5 px-1.5 pb-1 pt-0.5">
      {file.layers.map((layer) => (
        <span
          key={layer.kind}
          className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-background px-2 py-0.5"
        >
          <GeometryMark kind={layer.kind} label={layer.label} />
          <span className="font-medium tabular-nums text-[var(--tools-title)]">{layer.count}</span>
          <span className="text-muted-foreground">{layer.label}</span>
        </span>
      ))}
    </div>
    <div className="px-1.5 pb-1 text-xs text-muted-foreground">{file.asOf}</div>
    <div className="truncate px-1.5 pb-1 text-xs text-muted-foreground/70" title={file.fields}>
      {file.columns}
      <span className="font-mono">{file.fields}</span>
    </div>
  </>
);

/**
 * A search's or a look's row: the OSM logo, the tool's title, dimmed while the call runs and red once it failed, and
 * what it is about; once it has ended, it opens to a panel of its own.
 */
const OsmCallRow: React.FC<{
  part: ToolPart;
  animate: boolean;
  title: string;
  description: string;
  running: boolean;
  bad: boolean;
  panel: React.ReactNode;
}> = ({ part, animate, title, description, running, bad, panel }) => {
  const open = useRunRowOpen(part.id);
  const toggleOpen = useRunRowToggle();
  const opens = !running;
  const toggle = () => toggleOpen(part.id);
  return (
    <ToolRevealOnMount animate={animate} wipe>
      <div className="w-full min-w-0">
        <div
          className={cn(
            'group/tool oc-static-tool-row flex w-full min-w-0 items-center gap-x-1.5 rounded-xl py-1.5 pe-2 ps-px',
            opens && 'cursor-pointer',
          )}
          role={opens ? 'button' : undefined}
          tabIndex={opens ? 0 : undefined}
          aria-expanded={opens ? open : undefined}
          onClick={opens ? toggle : undefined}
          onKeyDown={(event) => {
            if (!opens || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            toggle();
          }}
        >
          <div className="relative h-5 w-3.5 flex-shrink-0">
            <div
              className={cn(
                'absolute inset-0 flex items-center justify-center transition-opacity',
                opens && (open ? 'opacity-0' : 'group-hover/tool:opacity-0'),
              )}
            >
              <OsmLogo className="h-3.5 w-3.5" />
            </div>
            {opens ? (
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-opacity',
                  open ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                )}
              >
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5" />
              </div>
            ) : null}
          </div>
          <MinDurationShineText
            active={running}
            minDurationMs={300}
            className={cn('typography-meta flex-shrink-0 font-medium', ROW_TEXT_CLASS)}
            style={{ color: bad ? 'var(--status-error)' : 'var(--tools-title)' }}
            title={title}
          >
            {title}
          </MinDurationShineText>
          <Text
            variant={animate ? 'generate-effect' : 'static'}
            className={cn('typography-meta min-w-0 flex-1 truncate whitespace-nowrap', ROW_TEXT_CLASS)}
            style={{ color: 'var(--tools-description)' }}
            title={description}
          >
            {description}
          </Text>
        </div>
        {opens ? (
          <Slide open={open}>
            <Panel>{panel}</Panel>
          </Slide>
        ) : null}
      </div>
    </ToolRevealOnMount>
  );
};

const OsmSearchRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) => {
  const locale = useI18nStore((state) => state.locale);
  const view = osmSearchView(part, locale);
  const words = osmText(locale);
  return (
    <OsmCallRow
      part={part}
      animate={animate}
      title={view.title}
      description={view.description}
      running={view.running}
      bad={view.bad}
      panel={
        <>
          <Notes notes={view.notes} />
          {view.notes.length && view.candidates.length ? <Divider /> : null}
          <Candidates candidates={view.candidates} kinds={words.kinds} more={words.moreCandidates} />
        </>
      }
    />
  );
};

const OsmProbeRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) => {
  const locale = useI18nStore((state) => state.locale);
  const view = osmProbeView(part, locale);
  const words = osmText(locale);
  return (
    <OsmCallRow
      part={part}
      animate={animate}
      title={view.title}
      description={view.description}
      running={view.running}
      bad={view.bad}
      panel={
        <>
          {view.groups.map((counts, index) => (
            <CountBars
              key={index}
              counts={counts}
              noneHere={words.noneHere}
              notCounted={words.notCounted}
              more={words.moreValues}
            />
          ))}
          {view.groups.length && view.notes.length ? <Divider /> : null}
          <Notes notes={view.notes} />
        </>
      }
    />
  );
};

/** How long a download's row waits between checks of how long it has been waiting on a server. */
const WAIT_TICK_MS = 1000;

/**
 * A download's row, as qgisrun's: the OSM logo and GeoAgent's label; while it runs, its step and the time so far,
 * opening to every step; once done, how many features it wrote, opening to its file or to why there is none.
 */
const OsmDownloadRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) => {
  const locale = useI18nStore((state) => state.locale);
  const running = part.state.status === 'pending' || part.state.status === 'running';
  const now = useDurationTickerNow(running, WAIT_TICK_MS);
  const view = osmDownloadView(part, locale, now);
  const panel = view.steps ? (
    <Steps steps={view.steps} />
  ) : (
    <>
      {view.file ? <Written file={view.file} /> : null}
      {view.file && view.notes.length ? <Divider /> : null}
      <Notes notes={view.notes} />
    </>
  );
  return (
    <RunRow
      id={part.id}
      animate={animate}
      logo={<OsmLogo className="h-3.5 w-3.5" />}
      title={view.title}
      bad={view.bad}
      after={
        view.added ? (
          <span
            className={cn('typography-meta flex-shrink-0 text-[var(--status-success)]', ROW_TEXT_CLASS)}
            title={view.added.hint}
          >
            +{view.added.count}
          </span>
        ) : undefined
      }
      doing={view.doing}
      percent={view.percent}
      start={view.start}
      end={view.end}
      lines={[]}
      panel={<Panel>{panel}</Panel>}
    />
  );
};

/** An OSM tool call's own row (docs/OSM.md, section 9). */
export const OsmRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) =>
  part.tool === 'osmsearch' ? (
    <OsmSearchRow part={part} animate={animate} />
  ) : part.tool === 'osmprobe' ? (
    <OsmProbeRow part={part} animate={animate} />
  ) : (
    <OsmDownloadRow part={part} animate={animate} />
  );
