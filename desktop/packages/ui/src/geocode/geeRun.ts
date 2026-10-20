import { z } from 'zod';

import type { Locale } from '@/lib/i18n';
import type { Message, SyntheticMessage, ToolPart } from '@/lib/opencode/model';

import { isBackgroundGeeRun } from './geeRunBackground';
import { geeRunTitle } from './geoTools';
import { descriptionOf, failureLines, type Line, linesOf } from './runLines';

/** What one of GeoCode's functions is doing; no text once none is doing anything. */
const status = z.object({ seq: z.number(), text: z.string().nullable(), progress: z.number().optional() });
export type Status = z.infer<typeof status>;

const outcome = z.enum(['finished', 'failed', 'crashed', 'idle']).optional().catch(undefined);

/** The kernel's account of a run, in the call's metadata: kept as it was when the run fails or the user stops it. */
const runMetadata = z.object({
  /** When the run began, after the user answered: the call itself began before the wait. */
  started: z.number().optional().catch(undefined),
  statuses: z.array(status).catch([]),
  /** The end of what the script printed. */
  log: z.string().catch(''),
  /** Present once requests have waited a while for Earth Engine, and as long as they wait. */
  waitingSince: z.number().optional().catch(undefined),
  /** Set once the script itself began, past starting Python and reading the task. */
  begun: z.literal(true).optional().catch(undefined),
  outcome,
});

/** The notification that ends a run in the background, as the kernel puts it into the conversation. */
const noticeMetadata = z.object({
  source: z.literal('geerun'),
  callID: z.string(),
  task: z.string(),
  state: z.string(),
  outcome,
  started: z.number().optional().catch(undefined),
  ended: z.number().optional().catch(undefined),
  log: z.string().optional().catch(undefined),
});

/** Where Python's report of an error begins: from there on, what the script printed is the error. */
const TRACEBACK = 'Traceback (most recent call last):';
/**
 * The notification's answer: its text without the opening tag and the closing one. The opening tag is rebuilt from
 * what the kernel wrote it with, as the description in it may span lines and hold quotes.
 */
const noticeAnswer = (notice: SyntheticMessage, { task, state }: z.infer<typeof noticeMetadata>) =>
  notice.text.slice(
    `<geerun task="${task}" state="${state}" description="${notice.description}">\n`.length,
    -'\n</geerun>'.length,
  );

/** The notification that ended a call's run in the background, among a conversation's messages. */
export const geeRunNotice = (messages: readonly Message[], callID: string) =>
  messages.find(
    (message): message is SyntheticMessage =>
      message.role === 'synthetic' &&
      message.metadata?.callID === callID &&
      noticeMetadata.safeParse(message.metadata).success,
  );

/** The answer's last paragraph, which says how the run ended. */
const endingOf = (answer: string) => answer.slice(answer.lastIndexOf('\n\n') + 2);

const logLines = (log: string): Line[] => {
  if (!log) return [];
  const lines = log.replace(/\n$/, '').split('\n');
  const traceback = lines.indexOf(TRACEBACK);
  return lines.map((text, index) => ({
    text,
    tone: traceback >= 0 && index >= traceback ? 'error' : 'plain',
    icon: false,
  }));
};

/** What a geerun call's row shows; `notice` is the notification that ended its run in the background, if any. */
export const geeRunView = (part: ToolPart, notice: SyntheticMessage | undefined, locale: Locale) => {
  const state = part.state;
  const metadata = runMetadata.safeParse('metadata' in state ? (state.metadata ?? {}) : {}).data;
  const background = isBackgroundGeeRun(part);
  const endNotice = background && notice ? noticeMetadata.safeParse(notice.metadata).data : undefined;
  const running = state.status === 'pending' || state.status === 'running' || (background && !endNotice);
  const error = state.status === 'error' ? state.error : undefined;

  // A run in the background ends with its notification: the answer is in its text, the times in its metadata.
  const answer =
    endNotice && notice
      ? noticeAnswer(notice, endNotice)
      : state.status === 'completed' && !background
        ? state.output
        : undefined;
  const result = background ? endNotice?.outcome : metadata?.outcome;
  // A notice the app gave on starting again has no end, as nothing saw the run stop: the row shows no time rather than
  // one counting while the app was shut.
  const start = endNotice && endNotice.ended === undefined ? undefined : (endNotice?.started ?? metadata?.started);
  const end = running
    ? undefined
    : endNotice
      ? endNotice.ended
      : 'time' in state && 'end' in state.time
        ? state.time.end
        : undefined;
  // A run in the background that failed outright, or that a restart stopped, has no outcome: its notice says why.
  const ending = answer === undefined ? undefined : result === undefined ? answer : endingOf(answer);
  const good = result === 'finished';

  const lines: Line[] = [
    ...logLines(endNotice?.log ?? metadata?.log ?? ''),
    ...(ending ? linesOf(ending, good ? 'success' : 'error', true) : []),
    ...(error === undefined ? [] : failureLines(error, start, end)),
  ];
  return {
    title: descriptionOf(state.input) ?? geeRunTitle(locale),
    running,
    /** Failed, crashed, idle, stopped, or ended outright by a failure or a restart. */
    bad: !running && (error !== undefined || (answer !== undefined && !good)),
    statuses: metadata?.statuses ?? [],
    begun: metadata?.begun === true,
    waitingSince: metadata?.waitingSince,
    start,
    end,
    lines,
  };
};

/** How long a status stays on the row at least, so one that came and went within a moment is still read. */
export const STATUS_MS = 800;
/**
 * How long the last status stays once no function is doing anything: the script's own requests to Earth Engine are
 * told within a second, and the row goes on to say so rather than going blank in between.
 */
const IDLE_MS = 1500;
/** How long a status stays at least when many wait their turn, so the row never falls far behind the run. */
const HURRIED_MS = 200;
/** How far behind the run the statuses waiting their turn may put the row, as long as each stays HURRIED_MS. */
const BEHIND_MS = 2000;

type Entry = { readonly text: string; readonly progress?: number };

/** The statuses the row shows in turn: the one shown, since when, and those waiting their turn. */
export type Shown = {
  /** The last status taken in. */
  readonly seq: number;
  readonly current?: Entry;
  readonly since: number;
  readonly queue: readonly Entry[];
  /** Since when no function is doing anything, as the last status taken in said. */
  readonly idleSince?: number;
};

/** What a row shows first: the latest status, not replaying those before it, as a row opened mid-run would. */
export const firstShown = (statuses: readonly Status[], now: number): Shown => {
  const last = statuses.at(-1);
  return {
    seq: last?.seq ?? 0,
    current: last?.text ? { text: last.text, progress: last.progress } : undefined,
    since: now,
    queue: [],
    idleSince: last?.text ? undefined : now,
  };
};

/**
 * What a row shows next: the statuses not yet taken in, a new text queued and a new share done of the same text
 * updated in place, moving on to the next once the one shown has stayed its time, the shorter the more wait.
 */
export const nextShown = (shown: Shown, statuses: readonly Status[], now: number): Shown => {
  let { seq, current, idleSince } = shown;
  const queue = [...shown.queue];
  for (const told of statuses) {
    if (told.seq <= seq) continue;
    seq = told.seq;
    idleSince = told.text === null ? (idleSince ?? now) : undefined;
    if (told.text === null) continue;
    const entry = { text: told.text, progress: told.progress };
    if (queue.at(-1)?.text === told.text) queue[queue.length - 1] = entry;
    else if (!queue.length && current?.text === told.text) current = entry;
    else queue.push(entry);
  }
  const stay = queue.length ? Math.max(HURRIED_MS, Math.min(STATUS_MS, BEHIND_MS / queue.length)) : STATUS_MS;
  const due = !current || now - shown.since >= stay;
  if (due && queue.length) return { seq, current: queue.shift(), since: now, queue, idleSince };
  if (due && current && idleSince !== undefined && now - idleSince >= IDLE_MS) {
    return { seq, current: undefined, since: now, queue, idleSince };
  }
  return { seq, current, since: shown.since, queue, idleSince };
};

/** In English whatever the interface language, as GeoCode's functions say what they do. */
const STARTING = 'Starting the script';
const WAITING = 'Waiting for Earth Engine';

/**
 * What the row says the run is doing, and its share done: nothing while the user is asked; that it is starting, until
 * the script begins; then the status in turn, or a wait for Earth Engine instead once no function is doing anything and
 * every status has had its time; no share before any of the work is done, as one that may never move says nothing.
 */
export const rowStatus = (
  shown: Shown,
  now: number,
  run: { readonly start?: number; readonly begun: boolean; readonly waitingSince?: number },
) => {
  if (!run.begun) return { doing: run.start === undefined ? undefined : STARTING, percent: undefined };
  const waiting = run.waitingSince !== undefined;
  const settled = shown.idleSince !== undefined && shown.queue.length === 0 && now - shown.since >= STATUS_MS;
  const current = waiting && settled ? undefined : shown.current;
  const percent = Math.floor((current?.progress ?? 0) * 100);
  return { doing: current?.text ?? (waiting ? WAITING : undefined), percent: percent > 0 ? percent : undefined };
};

/** Whether the row has still to move on by itself: a status waits its turn, or the one shown has to go. */
export const movesOn = (shown: Shown) =>
  shown.queue.length > 0 || (shown.idleSince !== undefined && shown.current !== undefined);
