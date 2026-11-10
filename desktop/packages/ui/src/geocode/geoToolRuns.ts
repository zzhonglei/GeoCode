import React from 'react';
import { create } from 'zustand';

import { isSkippedTimelineMessage } from '@/components/chat/lib/timelineRoles';
import type { TimelineEntry } from '@/components/chat/lib/turns/timelineEntries';
import type { ChatMessageEntry, TurnRecord } from '@/components/chat/lib/turns/types';
import { isInvisibleText } from '@/lib/invisibleText';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { useUIStore } from '@/stores/useUIStore';

import type { GeoTool } from './geoTools';
import { isOsmTool } from './osmView';

/** Calls of one geo tool with nothing shown between them, which the conversation shows as one row. */
type GeoToolRun = {
  /**
   * The call whose row stands for the run, the last: a collapsed activity group keeps its latest rows, so the
   * row survives whenever any of the run does. The others draw nothing.
   */
  readonly row: string;
  /** The run's first call, which stays the same as calls join it. */
  readonly first: string;
  readonly parts: readonly ToolPart[];
  /** Nothing shown follows it yet in a turn still working, so the model may yet go on. */
  readonly open: boolean;
};

export type Runs = ReadonlyMap<string, GeoToolRun>;

/** Whether a part draws a row: in a run only the call standing for it does, and any other part draws its own. */
export const isGeoRunRow = (part: Part, run: GeoToolRun | undefined) => !run || run.row === part.id;

/** How many rows a message's row parts draw: a run of geo calls draws one, in the message of its last call. */
export const geoDrawnRows = (parts: readonly Part[], runs: Runs | undefined) =>
  parts.filter((part) => isGeoRunRow(part, runs?.get(part.id))).length;

/** How many of a message's row parts it takes to draw its first `rows` rows, which is what MessageBody skips. */
export const geoRowParts = (parts: readonly Part[], rows: number, runs: Runs | undefined) => {
  let drawn = 0;
  let index = 0;
  while (index < parts.length && drawn < rows) {
    if (isGeoRunRow(parts[index], runs?.get(parts[index].id))) drawn += 1;
    index += 1;
  }
  return index;
};

/** The geo tools whose side-by-side calls the conversation shows as one row. */
const MERGED: ReadonlySet<string> = new Set(['qgisdoc', 'readgeodata'] satisfies GeoTool[]);

export const isMergedGeoTool = (toolName: string) => MERGED.has(toolName);

export const isMergedGeoPart = (part: Part): part is ToolPart => part.type === 'tool' && isMergedGeoTool(part.tool);

/**
 * Whether a tool's calls show as a geo tool's own rows: runs of merged calls, or a QGIS or Earth Engine run or an OSM
 * call each.
 */
export const hasGeoRow = (toolName: string) =>
  isMergedGeoTool(toolName) || toolName === 'qgisrun' || toolName === 'geerun' || isOsmTool(toolName);

/** Whether a part shows in the conversation, and so parts the calls on either side of it. */
const shows = (part: Part, showReasoningTraces: boolean) => {
  if (part.type === 'tool') return true;
  // As upstream draws them: a text of whitespace or zero-width characters alone draws nothing.
  if (part.type === 'text') return !isInvisibleText(part.text);
  if (part.type === 'reasoning') return showReasoningTraces && !isInvisibleText(part.text);
  return false;
};

const same = (left: GeoToolRun, right: GeoToolRun) =>
  left.open === right.open &&
  left.parts.length === right.parts.length &&
  left.parts.every((part, index) => part === right.parts[index]);

/**
 * Every merged geo tool call of a turn's replies, or of the side panel's whole conversation, by its id, with the run it
 * belongs to; runs cross steps but nothing shown, a message the timeline draws other than a reply included, and a call
 * of another tool ends one. A run that has not changed keeps its object, so its row does not render again for every
 * token streamed elsewhere.
 */
export const geoToolRuns = (
  messages: readonly ChatMessageEntry[],
  showReasoningTraces: boolean,
  working: boolean,
  previous: Runs,
) => {
  const runs = new Map<string, GeoToolRun>();
  let current: ToolPart[] = [];
  const close = (open: boolean) => {
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) return;
    const fresh = { row: last.id, first: first.id, parts: current, open };
    const kept = previous.get(last.id);
    const run = kept && same(kept, fresh) ? kept : fresh;
    for (const part of current) runs.set(part.id, run);
    current = [];
  };
  for (const message of messages) {
    // A notice the timeline draws between replies (a plugin's, a restart, a move) is shown like any other message.
    if (message.info.role !== 'assistant' && (!isSkippedTimelineMessage(message.info) || readSessionNotice(message.info))) {
      close(false);
    }
    for (const part of message.parts) {
      if (isMergedGeoPart(part)) {
        if (current[0] && current[0].tool !== part.tool) close(false);
        current.push(part);
      } else if (shows(part, showReasoningTraces)) close(false);
    }
  }
  close(working);
  return runs;
};

type RunState = {
  runs: Runs;
  /** Replaces a publisher's runs, leaving any id another publisher has claimed since. */
  publish: (runs: Runs, previous: Runs) => void;
};

// The chat's turns and the side panel publish their runs here, so a call's row knows its run without being passed it.
export const useGeoToolRunStore = create<RunState>()((set) => ({
  runs: new Map(),
  publish: (runs, previous) =>
    set((state) => {
      const next = new Map(state.runs);
      for (const [id, run] of previous) if (next.get(id) === run) next.delete(id);
      for (const [id, run] of runs) next.set(id, run);
      return { runs: next };
    }),
}));

const unchanged = (left: Runs, right: Runs) =>
  left.size === right.size && [...right].every(([id, run]) => left.get(id) === run);

/**
 * Publishes the runs of the messages given before paint, so a row left out of its run never shows for a frame, and
 * returns them.
 */
export const usePublishGeoToolRuns = (
  messages: readonly ChatMessageEntry[],
  showReasoningTraces: boolean,
  working: boolean,
) => {
  const published = React.useRef<Runs>(new Map());
  const computed = geoToolRuns(messages, showReasoningTraces, working, published.current);
  const runs = unchanged(published.current, computed) ? published.current : computed;
  React.useLayoutEffect(() => {
    if (runs.size === 0) return;
    const publish = useGeoToolRunStore.getState().publish;
    published.current = runs;
    publish(runs, new Map());
    return () => publish(new Map(), runs);
  }, [runs]);
  return runs;
};

/**
 * The runs of a turn's geo calls, for its fold to count the rows they draw. The store has them only a render after the
 * rows, and would count a call joining a run as a row of its own for that render.
 */
export const useTurnGeoToolRuns = (
  turn: Pick<TurnRecord, 'userMessage' | 'assistantMessages'>,
  showReasoningTraces: boolean,
) =>
  React.useMemo(
    () => geoToolRuns([turn.userMessage, ...turn.assistantMessages], showReasoningTraces, false, new Map()),
    [turn.userMessage, turn.assistantMessages, showReasoningTraces],
  );

const NO_MESSAGES: readonly ChatMessageEntry[] = [];

/** The messages of timeline entries in order: a turn's prompt and replies, or a message the timeline draws alone. */
const entryMessages = (entries: readonly TimelineEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'turn' ? [entry.turn.userMessage, ...entry.turn.assistantMessages] : [entry.message]));

type LiveTail = { get: () => TimelineEntry | null; subscribe: (listener: () => void) => () => void };

/**
 * Publishes the runs of the chat's timeline. A turn draws as several list rows, any of them unmounted off screen, so
 * no row can publish for its turn. The live tail's parts reach its rows through `liveTail`, ahead of the history.
 */
export const GeoToolRunsSource = React.memo(function GeoToolRunsSource({
  history,
  liveTail,
  working,
}: {
  history: readonly TimelineEntry[];
  liveTail: LiveTail;
  working: boolean;
}) {
  const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
  const historyMessages = React.useMemo(() => entryMessages(history), [history]);
  usePublishGeoToolRuns(historyMessages, showReasoningTraces, false);
  const live = React.useSyncExternalStore(liveTail.subscribe, liveTail.get);
  const liveMessages = React.useMemo(() => (live ? entryMessages([live]) : NO_MESSAGES), [live]);
  usePublishGeoToolRuns(liveMessages, showReasoningTraces, working && live?.kind === 'turn' && live.isLastTurn);
  return null;
});
