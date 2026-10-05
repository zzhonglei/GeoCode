import React from 'react';

import { MinDurationShineText } from '@/components/chat/message/parts/MinDurationShineText';
import { Text } from '@/components/ui/text';
import { useI18nStore } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';

import { geoToolDescription, qgisDocRunTitle } from './geoTools';
import { QgisLogo } from './QgisLogo';
import { useQgisDocRunStore } from './qgisDocRuns';

/** How long what the row reads stays before the next call replaces it, so it can be read. */
const HOLD_MS = 400;

// As the static tool rows draw theirs.
const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

const reading = (part: ToolPart) => part.state.status === 'pending' || part.state.status === 'running';

const subjectOf = (part: ToolPart) => {
  const description = geoToolDescription(part.tool, part.state.input);
  return description?.kind === 'text' ? description.value : undefined;
};

// By run, outside the row: a call joining the run moves the row to it, and the hold must not start over.
const held = new Map<string, { shown: string | undefined; since: number }>();

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

/**
 * A qgisdoc call's row: the last call of a run stands for all of it, the others draw nothing. It cannot be opened;
 * while the model may still read on, it says what the latest call reads.
 */
export const QgisDocRow: React.FC<{ part: ToolPart }> = ({ part }) => {
  const run = useQgisDocRunStore((state) => state.runs.get(part.id));
  // Subscribed so the title follows a change of language.
  useI18nStore((state) => state.locale);
  const parts = run?.parts ?? [part];
  const active = Boolean(run?.open) || parts.some(reading);
  const latest = parts.map(subjectOf).filter(Boolean).at(-1);
  const drawn = !run || run.row === part.id;
  const subject = useHeld(run?.first ?? part.id, active ? latest : undefined, drawn);
  if (!drawn) return null;

  const title = qgisDocRunTitle(active);
  return (
    <div className="oc-static-tool-row flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0">
      <div className="inline-flex h-5 items-center flex-shrink-0">
        <QgisLogo className="h-3.5 w-3.5 flex-shrink-0" />
      </div>
      <MinDurationShineText
        active={active}
        minDurationMs={1000}
        className={cn('typography-meta font-medium inline-flex items-center flex-shrink-0 opacity-85', ROW_TEXT_CLASS)}
        style={{ color: 'var(--tools-title)' }}
        title={title}
      >
        {title}
      </MinDurationShineText>
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
    </div>
  );
};
