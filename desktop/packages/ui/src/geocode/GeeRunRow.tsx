import React from 'react';

import { useToolContentCompletion } from '@/components/chat/message/parts/useToolContentCompletion';
import { Button } from '@/components/ui/button';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n, useI18nStore } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { useDirectorySync } from '@/sync/sync-context';

import {
  firstShown,
  geeRunNotice,
  geeRunView,
  movesOn,
  nextShown,
  rowStatus,
  type Shown,
  type Status,
} from './geeRun';
import { useBackgroundGeeRuns } from './backgroundGeeRuns';
import { isBackgroundGeeRun } from './geeRunBackground';
import { GeeLogo } from './GeeLogo';
import { RunRow } from './RunRow';
import { useRunRowOpen } from './runRowOpen';

/** The statuses the row shows in turn, each one long enough to be read however fast they come. */
const useRowStatus = (
  statuses: readonly Status[],
  running: boolean,
  run: { readonly start?: number; readonly begun: boolean; readonly waitingSince?: number },
) => {
  const shown = React.useRef<Shown | undefined>(undefined);
  // Moved on as the row renders: moving on twice at the same moment changes nothing.
  const now = Date.now();
  shown.current = shown.current ? nextShown(shown.current, statuses, now) : firstShown(statuses, now);
  // Renders again only while the row has to move on by itself; new statuses render it anyway.
  useDurationTickerNow(running && movesOn(shown.current), 100);
  return running ? rowStatus(shown.current, now, run) : { doing: undefined, percent: undefined };
};

/**
 * A geerun call's row: the Earth Engine logo and what GeoAgent says the step is for; while the run goes on, in the
 * foreground or the background, what GeoCode's functions are doing, their share done when known, and the time so far;
 * once done, the time it took, the title in the error colour unless it finished. It opens to what the script printed,
 * as it prints it, and how the run ended.
 */
export const GeeRunRow: React.FC<{ part: ToolPart; animate: boolean }> = ({ part, animate }) => {
  // Subscribed so the row follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  // Only a run in the background ends with a notification; looked up on every change of the conversation, so not for
  // any other call.
  const notice = useDirectorySync((state) =>
    isBackgroundGeeRun(part) ? geeRunNotice(state.message[part.sessionID] ?? [], part.callID) : undefined,
  );
  const open = useRunRowOpen(part.id);
  // History pages leave a finished call's answer out; a run in the background has its answer in the notification.
  const completion = useToolContentCompletion(part, open && part.state.status === 'completed' && !isBackgroundGeeRun(part));
  const { t } = useI18n();
  const listed = useBackgroundGeeRuns((state) => state.sessionIds.has(part.sessionID));
  const view = geeRunView(part, notice, listed, locale);
  const { doing, percent } = useRowStatus(view.statuses, view.running, view);
  const note =
    completion.status === 'failed' ? (
      <div className="typography-meta flex items-center gap-2 py-1 text-muted-foreground">
        <span>{t('chat.toolPart.content.loadFailed')}</span>
        <Button variant="ghost" size="xs" onClick={completion.retry}>
          {t('chat.toolPart.content.retry')}
        </Button>
      </div>
    ) : completion.status === 'loading' && completion.showProgress ? (
      <div className="typography-meta py-1 text-muted-foreground">{t('chat.toolPart.content.loading')}</div>
    ) : undefined;
  return (
    <RunRow
      id={part.id}
      animate={animate}
      logo={<GeeLogo className="h-3.5 w-3.5" />}
      title={view.title}
      bad={view.bad}
      doing={doing}
      percent={percent}
      start={view.start}
      end={view.end}
      lines={view.lines}
      note={note}
    />
  );
};
