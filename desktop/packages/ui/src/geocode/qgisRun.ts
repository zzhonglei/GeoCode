import { z } from 'zod';

import type { ToolPart } from '@/lib/opencode/model';

import type { Locale } from '@/lib/i18n';

import { qgisAlgorithm, qgisAlgorithmText, qgisRunTitle } from './geoTools';

/** The levels QGIS gives its messages; one it may add later shows as plain text. */
const level = z.enum(['info', 'warning', 'error', 'command', 'console']).catch('info');

/** The kernel's account of a run, in the call's metadata: kept as it was when the user stops the run. */
const runMetadata = z.object({
  /** When the run began, after the user answered: the call itself began before the wait. */
  started: z.number().optional().catch(undefined),
  algorithm: qgisAlgorithm.optional().catch(undefined),
  notes: z.array(z.string()).catch([]),
  messages: z.array(z.object({ level, text: z.string() })).catch([]),
  percent: z.number().optional().catch(undefined),
  outcome: z.enum(['finished', 'failed', 'timeout', 'crashed', 'refused']).optional().catch(undefined),
  ending: z.string().optional().catch(undefined),
});

const runInput = z.object({
  description: z.string().trim().min(1).optional().catch(undefined),
});

/** The kernel's words for a tool the user stopped. */
const INTERRUPTED = 'Tool execution interrupted';

export type Tone = 'plain' | 'command' | 'warning' | 'error' | 'success';

export type Line = {
  readonly text: string;
  readonly tone: Tone;
  readonly icon: boolean;
};

/** By QGIS's level, never by the words. */
const LEVELS = {
  info: 'plain',
  warning: 'warning',
  error: 'error',
  command: 'command',
  console: 'command',
} as const satisfies Record<z.infer<typeof level>, Tone>;

/** A message of several lines marks only its first. */
const linesOf = (text: string, tone: Tone, icon: boolean): Line[] =>
  text.split('\n').map((line, index) => ({ text: line, tone, icon: icon && index === 0 }));

/** As the kernel ends its answer: whole seconds, or tenths below one. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`;

const looksLikePath = (value: string) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

/** The end of the answer: each output on success, otherwise what stopped the run and what it may have left. */
const endingLines = (outcome: string, ending: string): Line[] => {
  if (outcome === 'finished') {
    const listed = ending.split('\n').filter((line) => line.startsWith('- '));
    if (!listed.length) return linesOf(ending.split('\n')[0] ?? ending, 'success', true);
    return listed.map((line) => {
      const entry = line.slice(2);
      const at = entry.indexOf(': ');
      const value = at < 0 ? entry : entry.slice(at + 2);
      return {
        text: looksLikePath(value) ? value : entry,
        tone: 'success',
        icon: true,
      };
    });
  }
  // Each reason's first line says why; the rest says what to do instead.
  if (outcome === 'refused') {
    return ending.split('\n\n').flatMap((reason) =>
      reason.split('\n').map(
        (line, index): Line => ({
          text: line,
          tone: index === 0 ? 'error' : 'plain',
          icon: index === 0,
        }),
      ),
    );
  }
  const at = ending.indexOf('\nThese outputs may be incomplete:');
  const why = at < 0 ? ending : ending.slice(0, at);
  const left = at < 0 ? [] : ending.slice(at + 1).split('\n');
  return [
    ...linesOf(why, 'error', true),
    ...left.map(
      (line, index): Line => ({
        text: line.replace(/^- /, ''),
        tone: 'warning',
        icon: index === 0,
      }),
    ),
  ];
};

/** What a qgisrun call's row shows. */
export const qgisRunView = (part: ToolPart, locale: Locale) => {
  const state = part.state;
  const running = state.status === 'pending' || state.status === 'running';
  const metadata = runMetadata.safeParse('metadata' in state ? (state.metadata ?? {}) : {}).data;
  // Counted from the run, not the call: nothing while the user is asked, nor for a run that never began.
  const start = metadata?.started;
  const end = 'time' in state && 'end' in state.time ? state.time.end : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const outcome = metadata?.outcome;
  const stopped = error !== undefined && outcome === undefined && error.includes(INTERRUPTED);
  const lines: Line[] = [
    ...(metadata?.notes ?? []).flatMap((note) => linesOf(note, 'plain', false)),
    ...(metadata?.messages ?? []).flatMap((message) => {
      const tone = LEVELS[message.level];
      return linesOf(message.text, tone, tone === 'warning' || tone === 'error');
    }),
    ...(outcome && metadata?.ending ? endingLines(outcome, metadata.ending) : []),
    // Only the interface says the user stopped the run: the kernel hands GeoAgent nothing of it.
    ...(stopped && start !== undefined && end !== undefined
      ? linesOf(`Stopped by the user after ${seconds(end - start)}.`, 'error', true)
      : error !== undefined && !stopped && outcome === undefined
        ? linesOf(error, 'error', true)
        : []),
  ];
  return {
    title: runInput.safeParse(state.input).data?.description ?? qgisRunTitle(locale),
    running,
    /** Failed, timed out, crashed, refused or stopped. */
    bad: (outcome !== undefined && outcome !== 'finished') || error !== undefined,
    algorithm: metadata?.algorithm && qgisAlgorithmText(metadata.algorithm, locale),
    percent: running ? metadata?.percent : undefined,
    start,
    end: running ? undefined : end,
    lines,
  };
};
