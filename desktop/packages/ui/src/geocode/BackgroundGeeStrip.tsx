import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ShellElapsed } from '@/components/chat/BackgroundShellsStrip';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { sessionsInTree } from '@/sync/background-shells';

import { type BackgroundGeeRun, useBackgroundGeeRuns } from './backgroundGeeRuns';
import { GeeLogo } from './GeeLogo';
import { geeBackgroundText } from './geoTools';

/** Runs of this session and of its subagents, oldest first, found as the commands' strip finds its commands. */
const useTreeRuns = (sessionId: string): readonly BackgroundGeeRun[] => {
  const sessionIds = useBackgroundGeeRuns((state) => state.sessionIds);
  const treeKey = useGlobalSessionsStore(
    React.useCallback(
      (state) =>
        sessionIds.size === 0
          ? ''
          : sessionsInTree(sessionIds, sessionId, (id) => state.entityById.get(id)?.parentID ?? undefined).join('\n'),
      [sessionId, sessionIds],
    ),
  );
  return useBackgroundGeeRuns(
    useShallow(
      React.useCallback(
        (state) => {
          const tree = new Set(treeKey ? treeKey.split('\n') : []);
          return state.runs.filter((run) => tree.has(run.sessionID)).sort((a, b) => a.startedAt - b.startedAt);
        },
        [treeKey],
      ),
    ),
  );
};

const STOP_BUTTON_CLASS = 'shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error';

/** Stops runs as the commands' strip stops its commands: a row stays disabled until its run ends and leaves the list. */
const useStopRuns = () => {
  const { locale } = useI18n();
  const [stoppingIds, setStoppingIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const stop = React.useCallback(
    (runs: readonly BackgroundGeeRun[]) => {
      const pending = runs.filter((run) => !stoppingIds.has(run.id));
      if (pending.length === 0) return;
      setStoppingIds((current) => new Set([...current, ...pending.map((run) => run.id)]));
      void Promise.allSettled(pending.map((run) => opencodeClient.stopGeeRun(run.id))).then((results) => {
        const failed = pending.filter((_, index) => results[index].status === 'rejected');
        if (failed.length === 0) return;
        setStoppingIds((current) => {
          const next = new Set(current);
          for (const run of failed) next.delete(run.id);
          return next;
        });
        toast.error(geeBackgroundText(locale).stopFailed);
      });
    },
    [locale, stoppingIds],
  );

  return { stoppingIds, stop };
};

/** A run's row, drawn as BackgroundShellsStrip draws a command's, with what GeoAgent said the run is for. */
const RunRow: React.FC<{
  run: BackgroundGeeRun;
  fromSubagent: boolean;
  stopping: boolean;
  onStop: (run: BackgroundGeeRun) => void;
}> = ({ run, fromSubagent, stopping, onStop }) => {
  const { t, locale } = useI18n();
  const text = geeBackgroundText(locale);
  return (
    <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
      <GeeLogo className="size-3.5 shrink-0" />
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate typography-meta text-foreground">{run.description}</span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-[min(36rem,90vw)] [text-wrap:wrap]">
          <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words typography-meta">
            {run.description}
          </div>
        </TooltipContent>
      </Tooltip>
      {fromSubagent ? (
        <span className="shrink-0 typography-meta text-muted-foreground">{t('chat.backgroundShells.subagent')}</span>
      ) : null}
      <ShellElapsed startedAt={run.startedAt} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={stopping}
        onClick={() => onStop(run)}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={text.stopAria(run.description)}
        className={STOP_BUTTON_CLASS}
      >
        {text.stop}
      </Button>
    </div>
  );
};

/**
 * Earth Engine runs in the background, under the commands running there and shown as they are: one run is its own
 * row, several fold into a count that expands in place, with a stop for each and for all.
 */
export const BackgroundGeeStrip: React.FC<{ sessionId: string | null }> = React.memo(({ sessionId }) => {
  const { locale } = useI18n();
  const runs = useTreeRuns(sessionId ?? '');
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const { stoppingIds, stop } = useStopRuns();
  const stopOne = React.useCallback((run: BackgroundGeeRun) => stop([run]), [stop]);

  if (!sessionId || runs.length === 0) return null;

  const text = geeBackgroundText(locale);
  const row = (run: BackgroundGeeRun) => (
    <RunRow
      key={run.id}
      run={run}
      fromSubagent={run.sessionID !== sessionId}
      stopping={stoppingIds.has(run.id)}
      onStop={stopOne}
    />
  );

  return (
    <div role="group" className="border-b border-border/60" aria-label={text.strip}>
      {runs.length === 1 ? (
        row(runs[0])
      ) : (
        <>
          <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              onMouseDown={(event) => event.preventDefault()}
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
            >
              <GeeLogo className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-start">{text.count(runs.length)}</span>
              <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={runs.every((run) => stoppingIds.has(run.id))}
              onClick={() => stop(runs)}
              onMouseDown={(event) => event.preventDefault()}
              className={STOP_BUTTON_CLASS}
            >
              {text.stopAll}
            </Button>
          </div>
          {expanded ? <div id={listId}>{runs.map(row)}</div> : null}
        </>
      )}
    </div>
  );
});

BackgroundGeeStrip.displayName = 'BackgroundGeeStrip';
