import React from 'react';
import { create } from 'zustand';

import { dispatchRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { MinDurationShineText } from '@/components/chat/message/parts/MinDurationShineText';
import { ToolRevealOnMount } from '@/components/chat/message/parts/ToolRevealOnMount';
import { Icon } from '@/components/icon/Icon';
import { Text } from '@/components/ui/text';
import { useI18nStore, type Locale } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

import { EarthIcon } from './EarthIcon';
import { GeeRunRow } from './GeeRunRow';
import { geoDataPath, geoFailedCount, geoFileCount, geoRunTitle, geoToolDescription } from './geoTools';
import { isGeoRunRow, useGeoToolRunStore } from './geoToolRuns';
import { OsmRow } from './OsmRows';
import { isOsmTool } from './osmView';
import { QgisLogo } from './QgisLogo';
import { QgisRunRow } from './QgisRunRow';
import { failureLines } from './runLines';

/** How long what the row reads stays before the next call replaces it, so it can be read. */
const HOLD_MS = 400;

// As the static tool rows draw theirs.
const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

const working = (part: ToolPart) => part.state.status === 'pending' || part.state.status === 'running';

const subjectOf = (part: ToolPart) => geoToolDescription(part.tool, part.state.input);

/** Why a call failed, as the other geo rows say it; undefined for one that did not. */
const failureOf = (part: ToolPart) =>
  part.state.status === 'error'
    ? failureLines(part.state.error, undefined, undefined)
        .map((line) => line.text)
        .join('\n')
    : undefined;

/** How many of a row's calls failed, in the colour of an error, with why on hover. */
const Failed: React.FC<{ failures: readonly string[]; locale: Locale }> = ({
  failures,
  locale,
}) =>
  failures.length > 0 ? (
    <Text
      variant="static"
      className={cn('typography-meta flex-shrink-0 whitespace-nowrap', ROW_TEXT_CLASS)}
      style={{ color: 'var(--status-error)' }}
      title={failures.join('\n\n')}
    >
      {geoFailedCount(failures.length, locale)}
    </Text>
  ) : null;

// By run, outside the row: a call joining the run moves the row to it, and neither may start over.
const held = new Map<string, { shown: string | undefined; since: number }>();

// A store rather than a plain set: the React Compiler keeps what a render reads from a module's own values.
const useExpanded = create<{ runs: ReadonlySet<string>; toggle: (key: string) => void }>()((set) => ({
  runs: new Set(),
  toggle: (key) =>
    set((state) => {
      const runs = new Set(state.runs);
      if (!runs.delete(key)) runs.add(key);
      return { runs };
    }),
}));

// The call whose row first stood for its run, by the run's first call: every call joining the run mounts the row anew.
const useFirstRow = create<{ by: ReadonlyMap<string, string>; claim: (run: string, call: string) => void }>()(
  (set) => ({
    by: new Map(),
    claim: (run, call) => set((state) => (state.by.has(run) ? state : { by: new Map(state.by).set(run, call) })),
  }),
);

/**
 * Whether the row plays the reveal a new tool row plays (`animate`, decided by the message as for its other rows):
 * only as the row that first stood for its run, so not for a call joining a run already shown, from history too. A new
 * call renders before its turn publishes its run, so the row decides once it knows the run.
 */
const useReveal = (run: string | undefined, call: string, drawn: boolean, animate: boolean) => {
  const first = useFirstRow((state) => (run === undefined ? undefined : state.by.get(run)));
  const claim = useFirstRow((state) => state.claim);
  React.useLayoutEffect(() => {
    if (run !== undefined && drawn) claim(run, call);
  }, [run, drawn, claim, call]);
  return run !== undefined && drawn && animate && (first ?? call) === call;
};

/** The latest value, changed no sooner than `HOLD_MS` after the last change. */
const useHeld = (key: string, value: string | undefined, drawn: boolean) => {
  const [shown, setShown] = React.useState(() => (held.has(key) ? held.get(key)?.shown : value));
  const mounted = React.useRef(Date.now());
  React.useEffect(() => {
    if (!drawn || value === shown) return;
    const entry = held.get(key) ?? { shown, since: mounted.current };
    held.set(key, entry);
    const show = () => {
      setShown(value);
      if (value === undefined) held.delete(key);
      else Object.assign(entry, { shown: value, since: Date.now() });
    };
    const wait = entry.since + HOLD_MS - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [key, value, shown, drawn]);
  return shown;
};

const Title: React.FC<{ active: boolean; title: string }> = ({ active, title }) => (
  <MinDurationShineText
    active={active}
    minDurationMs={1000}
    className={cn('typography-meta font-medium inline-flex items-center flex-shrink-0 opacity-85', ROW_TEXT_CLASS)}
    style={{ color: 'var(--tools-title)' }}
    title={title}
  >
    {title}
  </MinDurationShineText>
);

/**
 * A merged geo tool call's row: the last call of a run stands for all of it, the others draw nothing. A row of qgisdoc
 * calls cannot be opened, and while the model may still read on it says what the latest call reads; a row of
 * readgeodata calls counts the files read and opens to list them.
 */
export const GeoToolRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) => {
  const run = useGeoToolRunStore((state) => state.runs.get(part.id));
  // Subscribed so the titles follow a change of language; passed to the file count, which the compiler keeps while the
  // count stays the same.
  const locale = useI18nStore((state) => state.locale);
  const parts = run?.parts ?? [part];
  const key = run?.first ?? part.id;
  const active = Boolean(run?.open) || parts.some(working);
  const latest = parts.map(subjectOf).filter(Boolean).at(-1);
  const failures = parts.map(failureOf).filter((failure): failure is string => failure !== undefined);
  const drawn = isGeoRunRow(part, run);
  const subject = useHeld(key, active ? latest : undefined, drawn);
  // By the run's key, so the row stays open as it moves to a call joining the run.
  const open = useExpanded((state) => state.runs.has(key));
  const toggleRun = useExpanded((state) => state.toggle);
  const reveal = useReveal(run?.first, part.id, drawn, animate);
  if (!drawn) return null;

  if (part.tool !== 'readgeodata') {
    return (
      <ToolRevealOnMount animate={reveal} wipe>
        <div className="oc-static-tool-row flex w-full items-center gap-x-1.5 pe-2 ps-px py-1.5 rounded-xl min-w-0">
          <div className="inline-flex h-5 items-center flex-shrink-0">
            <QgisLogo className="h-3.5 w-3.5 flex-shrink-0" />
          </div>
          <Title active={active} title={geoRunTitle('qgisdoc', active)} />
          {active && subject ? (
            <Text
              key={subject}
              variant="generate-effect"
              className={cn('typography-meta min-w-0 flex-1 truncate whitespace-nowrap', ROW_TEXT_CLASS)}
              style={{ color: 'var(--tools-description)' }}
              title={subject}
            >
              {subject}
            </Text>
          ) : null}
          <Failed failures={failures} locale={locale} />
        </div>
      </ToolRevealOnMount>
    );
  }

  const read = parts.filter((call) => call.state.status !== 'error');
  const files = [...new Set(read.map(subjectOf).filter((file): file is string => Boolean(file)))];
  // Files, not entries: the layers of one file are listed apart.
  const count = new Set(read.map((call) => geoDataPath(call.state.input)).filter(Boolean)).size;
  const failed = parts.flatMap((call) => {
    const failure = failureOf(call);
    return failure === undefined ? [] : [{ id: call.id, file: subjectOf(call), failure }];
  });
  // As RunRow's.
  const toggle = (row: HTMLElement) => {
    if (!open) dispatchRowExpand(row);
    toggleRun(key);
  };
  return (
    <ToolRevealOnMount animate={reveal} wipe>
      <div className="w-full min-w-0">
        <div
          className="group/tool oc-static-tool-row flex w-full items-center gap-x-1.5 pe-2 ps-px py-1.5 rounded-xl min-w-0 cursor-pointer"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={(event) => toggle(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle(event.currentTarget);
          }}
        >
          <div className="relative h-5 w-3.5 flex-shrink-0">
            <div
              className={cn(
                'absolute inset-0 flex items-center justify-center transition-opacity',
                open ? 'opacity-0' : 'group-hover/tool:opacity-0',
              )}
            >
              <EarthIcon className="h-3.5 w-3.5" />
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
          <Title active={active} title={geoRunTitle('readgeodata', active)} />
          {count > 0 ? (
            <Text
              variant={reveal ? 'generate-effect' : 'static'}
              className={cn('typography-meta min-w-0 flex-1 truncate whitespace-nowrap', ROW_TEXT_CLASS)}
              style={{ color: 'var(--tools-description)' }}
            >
              {geoFileCount(count, locale)}
            </Text>
          ) : null}
          <Failed failures={failures} locale={locale} />
        </div>
        {open ? (
          <div className="pb-1 ps-6 pe-2 min-w-0">
            {files.map((file) => (
              <div
                key={file}
                className={cn('typography-meta truncate whitespace-nowrap', ROW_TEXT_CLASS)}
                style={{ color: 'var(--tools-description)' }}
                title={file}
              >
                {file}
              </div>
            ))}
            {failed.map((call) => (
              <div key={call.id} className="min-w-0">
                {call.file ? (
                  <div
                    className={cn('typography-meta truncate whitespace-nowrap', ROW_TEXT_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                    title={call.file}
                  >
                    {call.file}
                  </div>
                ) : null}
                <div
                  className={cn('typography-meta whitespace-pre-wrap break-words', ROW_TEXT_CLASS)}
                  style={{ color: 'var(--status-error)' }}
                >
                  {call.failure}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </ToolRevealOnMount>
  );
};

/** A geo tool call's own row; `animate` when the message reveals the call as a new tool row. */
export const GeoRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) =>
  part.tool === 'qgisrun' ? (
    <QgisRunRow part={part} animate={animate} />
  ) : part.tool === 'geerun' ? (
    <GeeRunRow part={part} animate={animate} />
  ) : isOsmTool(part.tool) ? (
    <OsmRow part={part} animate={animate} />
  ) : (
    <GeoToolRow part={part} animate={animate} />
  );
