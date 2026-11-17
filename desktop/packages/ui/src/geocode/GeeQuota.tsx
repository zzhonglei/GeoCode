import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { quotaRows, useGeeQuota, type QuotaRows } from './geeQuotaStore';
import type { GeeText } from './geeText';

const TONE_CLASS = {
  plain: 'text-foreground',
  muted: 'text-muted-foreground',
  error: 'text-[var(--status-error)]',
} satisfies Record<QuotaRows['first']['tone'], string>;

/** The project's quota rows, asked for as the view opens unless one asked recently. */
const useQuotaRows = (project: string, text: GeeText['quota']) => {
  const entry = useGeeQuota((state) => state.entry);
  const ensure = useGeeQuota((state) => state.ensure);
  const preference = useUIStore((state) => state.timeFormatPreference);
  React.useEffect(() => ensure(project), [ensure, project]);
  return quotaRows(entry?.project === project ? entry : null, text, preference);
};

/**
 * The share used; an outline where the project has no limit, since an empty bar would read as nothing used. Hidden
 * from screen readers, which read the value beside it: the bar would read an unknown usage as 0%.
 */
const QuotaBar: React.FC<{ bar: QuotaRows['bar']; className?: string }> = ({ bar, className }) => (
  <div aria-hidden className={className}>
    {bar.kind === 'unlimited' ? (
      // As tall and round as UsageProgressBar's track.
      <div className="h-2.5 rounded-full border border-dashed border-[var(--interactive-border-hover)]" />
    ) : (
      <UsageProgressBar percent={bar.kind === 'share' ? bar.percent : null} />
    )}
  </div>
);

/**
 * Under the project in the status card. Each row is one line, cut short rather than wrapped, and every state fills
 * each of them, so the card keeps its height as the quota is asked for, found or not found.
 */
export const GeeQuotaCard: React.FC<{ project: string; text: GeeText['quota'] }> = ({ project, text }) => {
  const rows = useQuotaRows(project, text);
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="typography-meta flex items-center justify-between gap-3">
        <span className="shrink-0 text-foreground">{text.heading}</span>
        <span className={cn('truncate tabular-nums', TONE_CLASS[rows.valueTone])} title={rows.value}>{rows.value}</span>
      </div>
      <QuotaBar bar={rows.bar} />
      <p className={cn('typography-micro truncate', TONE_CLASS[rows.card.tone])} title={rows.card.text}>
        {rows.card.text}
      </p>
    </div>
  );
};

/** The overview's quota line: what was used beside the heading, and when it resets under the bar, or why it is not known. */
const stripOf = (rows: QuotaRows, text: GeeText['quota']) => {
  if (rows.first.tone === 'error') {
    const why = [rows.first.detail ?? rows.first.text, rows.second.text].filter(Boolean).join('\n');
    return { value: rows.value, valueTone: rows.valueTone, line: rows.first.text, lineTone: rows.first.tone, title: why };
  }
  // A dashed bar alone does not say there is no limit.
  const value = rows.bar.kind === 'unlimited' ? text.together(rows.first.text, rows.value) : rows.first.text;
  return { value, valueTone: rows.first.tone, line: rows.second.text, lineTone: rows.second.tone, title: rows.second.text };
};

/** The heading, the hours used or the share, the bar and one line, the same rows in every state. */
const Strip: React.FC<{
  heading: string;
  value: string;
  valueTone: QuotaRows['valueTone'];
  bar: QuotaRows['bar'];
  line: string;
  lineTone: QuotaRows['valueTone'];
  title: string;
  refresh?: React.ReactNode;
}> = ({ heading, value, valueTone, bar, line, lineTone, title, refresh }) => (
  <div className="border-t border-[var(--interactive-border)] px-4 pb-3 pt-2.5">
    <div className="flex h-6 items-center gap-2">
      <span className="typography-micro min-w-0 flex-1 truncate text-muted-foreground">{heading}</span>
      <span className={cn('typography-meta truncate tabular-nums', TONE_CLASS[valueTone])} title={value}>{value}</span>
      {refresh ?? <span aria-hidden className="size-6 shrink-0" />}
    </div>
    <QuotaBar bar={bar} className="mt-1.5" />
    <p className={cn('typography-micro mt-1.5 h-4 truncate leading-4', TONE_CLASS[lineTone])} title={title || undefined}>
      {/* A no-break space holds an empty line's height; a plain one would collapse. */}
      {line || '\u00a0'}
    </p>
  </div>
);

/**
 * The bottom of the settings page's overview, in every state: the project's quota once Earth Engine is ready, with a
 * refresh that leaves it shown until the new one comes, and when none does; the same rows, empty, before then.
 */
export const GeeQuotaStrip: React.FC<{ project: string | undefined; text: GeeText['quota'] }> = ({ project, text }) =>
  project === undefined ? (
    <Strip heading={text.heading} value="—" valueTone="muted" bar={{ kind: 'empty' }} line={text.notReady} lineTone="muted" title="" />
  ) : (
    <LiveStrip project={project} text={text} />
  );

const LiveStrip: React.FC<{ project: string; text: GeeText['quota'] }> = ({ project, text }) => {
  const rows = useQuotaRows(project, text);
  const refresh = useGeeQuota((state) => state.refresh);
  return (
    <Strip
      heading={text.heading}
      bar={rows.bar}
      {...stripOf(rows, text)}
      refresh={(
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground"
          // Not disabled while it runs, which would drop the keyboard's focus; a press then is ignored.
          onClick={() => refresh(project)}
          aria-label={text.refresh}
          aria-busy={rows.busy}
          title={text.refreshTitle}
        >
          <Icon name="refresh" className={cn('size-3.5', rows.busy && 'animate-spin')} />
        </Button>
      )}
    />
  );
};
