import React from 'react';
import { create } from 'zustand';

import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import type { Part, ToolPart } from '@/lib/opencode/model';

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

type Runs = ReadonlyMap<string, GeoToolRun>;

/** The geo tools whose side-by-side calls the conversation shows as one row. */
const MERGED = new Set(['qgisdoc', 'readgeodata']);

export const isMergedGeoTool = (toolName: string) => MERGED.has(toolName);

export const isMergedGeoPart = (part: Part): part is ToolPart => part.type === 'tool' && isMergedGeoTool(part.tool);

/** Whether a tool's calls show as a geo tool's own rows: runs of merged calls, or a QGIS or Earth Engine run each. */
export const hasGeoRow = (toolName: string) =>
  isMergedGeoTool(toolName) || toolName === 'qgisrun' || toolName === 'geerun';

export const isGeoRowPart = (part: Part): part is ToolPart => part.type === 'tool' && hasGeoRow(part.tool);

/** Whether a part shows in the conversation, and so parts the calls on either side of it. */
const shows = (part: Part, showReasoningTraces: boolean) => {
  if (part.type === 'tool') return true;
  if (part.type === 'text') return part.text.trim().length > 0;
  if (part.type === 'reasoning') return showReasoningTraces && part.text.trim().length > 0;
  return false;
};

const same = (left: GeoToolRun, right: GeoToolRun) =>
  left.open === right.open &&
  left.parts.length === right.parts.length &&
  left.parts.every((part, index) => part === right.parts[index]);

/**
 * Every merged geo tool call of a turn, by its id, with the run it belongs to; runs cross steps but nothing shown, and
 * a call of another tool ends one. A run that has not changed keeps its object, so its row does not render again for
 * every token streamed elsewhere.
 */
const geoToolRuns = (messages: readonly ChatMessageEntry[], showReasoningTraces: boolean, working: boolean, previous: Runs) => {
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
  /** Replaces a turn's runs, leaving any id another turn has claimed since. */
  publish: (runs: Runs, previous: Runs) => void;
};

// Turns publish their runs here, so a call's row knows its run without the timeline passing it down.
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

/** Publishes a turn's runs; before paint, so a row left out of its run never shows for a frame. */
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
};
