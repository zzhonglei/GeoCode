import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
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

/**
 * The settings page's last section: the same rows in every state, as the status card's, with two lines and a refresh
 * button; a refresh leaves the quota shown until the new one comes, and when none does.
 */
export const GeeQuotaSection: React.FC<{ project: string; text: GeeText['quota'] }> = ({ project, text }) => {
  const rows = useQuotaRows(project, text);
  const refresh = useGeeQuota((state) => state.refresh);
  return (
    <SettingsSection
      title={text.heading}
      titleAccessory={
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
      }
      settingsItem="geo-environment.gee.quota"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3.5">
          <QuotaBar bar={rows.bar} className="min-w-0 flex-1" />
          <span className={cn('typography-meta shrink-0 whitespace-nowrap tabular-nums', TONE_CLASS[rows.valueTone])}>
            {rows.value}
          </span>
        </div>
        <p className={cn('typography-meta truncate', TONE_CLASS[rows.first.tone])} title={rows.first.detail ?? rows.first.text}>
          {rows.first.text}
        </p>
        <p className={cn('typography-micro truncate', TONE_CLASS[rows.second.tone])} title={rows.second.text || undefined}>
          {/* A no-break space holds an empty line's height; a plain one would collapse. */}
          {rows.second.text || ' '}
        </p>
      </div>
    </SettingsSection>
  );
};
