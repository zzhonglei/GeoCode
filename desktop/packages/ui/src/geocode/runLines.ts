import { z } from 'zod';

import type { ToolInput } from '@/lib/opencode/model';

export type Tone = 'plain' | 'command' | 'warning' | 'error' | 'success';

export type Line = {
  readonly text: string;
  readonly tone: Tone;
  readonly icon: boolean;
};

/** The kernel's words for a tool the user stopped. */
const INTERRUPTED = 'Tool execution interrupted';

/** A message of several lines marks only its first. */
export const linesOf = (text: string, tone: Tone, icon: boolean): Line[] =>
  text.split('\n').map((line, index) => ({ text: line, tone, icon: icon && index === 0 }));

/** As the kernel ends its answer: whole seconds, or tenths below one. */
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms / 100)) / 10} s` : `${Math.round(ms / 1000)} s`;

/**
 * How a call the kernel ended in an error ends its row: the error, or that the user stopped it, which only the
 * interface says, as the kernel hands GeoAgent nothing of it.
 */
export const failureLines = (error: string, start: number | undefined, end: number | undefined): Line[] =>
  linesOf(
    !error.includes(INTERRUPTED)
      ? error
      : start !== undefined && end !== undefined
        ? `Stopped by the user after ${seconds(end - start)}.`
        : 'Stopped by the user.',
    'error',
    true,
  );

const runInput = z.object({
  description: z.string().trim().min(1).optional().catch(undefined),
});

/** What GeoAgent says the call is for, if it said. */
export const descriptionOf = (input: ToolInput) => runInput.safeParse(input).data?.description;
