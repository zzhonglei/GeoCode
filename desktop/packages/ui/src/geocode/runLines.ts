import { z } from 'zod';

import type { ToolInput } from '@/lib/opencode/model';

export type Tone = 'plain' | 'command' | 'warning' | 'error' | 'success';

export type Line = {
  readonly text: string;
  readonly tone: Tone;
  readonly icon: boolean;
};

/** The kernel's words for a tool it interrupted. */
const INTERRUPTED = 'Tool execution interrupted';
/** The interface's words for a call it closed itself when its turn ended without one. */
const CLOSED = 'Interrupted';
/** The kernel's words for a call the user declined when asked. */
const DECLINED = 'The user declined this tool call';

/** A message of several lines marks only its first. */
export const linesOf = (text: string, tone: Tone, icon: boolean): Line[] =>
  text.split('\n').map((line, index) => ({ text: line, tone, icon: icon && index === 0 }));

/** Whether a call's error says it was interrupted, by whomever. */
export const wasInterrupted = (error: string) => error.includes(INTERRUPTED) || error === CLOSED;

/** Whether the user declined the call when asked about it. */
export const wasDeclined = (error: string) => error.includes(DECLINED);

/** As the kernel ends its answer: whole seconds, or tenths below one. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`;

/**
 * How a call the kernel ended in an error ends its row: the error, that the user declined it, or that it was
 * interrupted. Not by whom: the words are the same whoever interrupted it, and the kernel hands GeoAgent nothing of it.
 */
export const failureLines = (error: string, start: number | undefined, end: number | undefined): Line[] =>
  linesOf(
    wasDeclined(error)
      ? 'Declined.'
      : !wasInterrupted(error)
        ? error
        : start !== undefined && end !== undefined
          ? `Interrupted after ${seconds(end - start)}.`
          : 'Interrupted.',
    'error',
    true,
  );

const runInput = z.object({
  description: z.string().trim().min(1).optional().catch(undefined),
});

/** What GeoAgent says the call is for, if it said. */
export const descriptionOf = (input: ToolInput) => runInput.safeParse(input).data?.description;
