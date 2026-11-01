import { describe, expect, test } from 'bun:test';

import type { Metadata, SyntheticMessage, ToolPart, ToolState } from '@/lib/opencode/model';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE } from '@/sync/types';

import { firstShown, geeRunView, movesOnAt, nextShown, type Status } from './geeRun';

const call = (state: ToolState): ToolPart => ({
  id: 'call_gee',
  sessionID: 'ses_1',
  messageID: 'msg_a',
  type: 'tool',
  callID: 'call_gee',
  tool: 'geerun',
  state,
});

const INPUT = { description: '下载台北真彩色影像', task: 'taipei-rgb-20261012', script: 'print(1)' };

/** The kernel's answer to a call whose run went on in the background. */
const backgrounded = (metadata: Metadata = {}) =>
  call({
    status: 'completed',
    input: INPUT,
    output: 'Task taipei-rgb-20261012 is running in the background.',
    metadata: { started: 1000, statuses: [], log: '', status: 'running', ...metadata },
    time: { start: 900, end: 1500 },
  });

describe("GeoCode: geerun's row", () => {
  // Guards against the kernel's progress for a run in the background being dropped, or reopening other calls.
  test("the conversation takes a background run's progress onto its answered call, and no other call's", () => {
    const progress = (metadata: Metadata) => ({
      type: 'message.tool.transition' as const,
      properties: { sessionID: 'ses_1', messageID: 'msg_a', partID: 'call_gee', transition: { kind: 'progress' as const, metadata } },
    });
    const draft = { ...INITIAL_STATE, part: { msg_a: [backgrounded()] } };
    expect(applyDirectoryEvent(draft, progress({ status: 'running', log: 'images: 73\n' }))).not.toBe(false);
    expect(draft.part.msg_a[0]).toMatchObject({ state: { status: 'completed', metadata: { log: 'images: 73\n' } } });
    // Progress the call gave before it was answered, not on the bus.
    expect(applyDirectoryEvent(draft, progress({ log: '' }))).toBe(false);

    const answered = { ...INITIAL_STATE, part: { msg_a: [backgrounded({ status: null })] } };
    expect(applyDirectoryEvent(answered, progress({ status: 'running' }))).toBe(false);
  });

  // Guards against a description of several lines hiding how a run in the background ended.
  test('a background run ends as its notification says, whatever lines its description holds', () => {
    const description = '下载台北真彩色影像\n并导出 RGB';
    const notice: SyntheticMessage = {
      id: 'msg_notice',
      sessionID: 'ses_1',
      role: 'synthetic',
      time: { created: 5000 },
      description,
      text: `<geerun task="${INPUT.task}" state="completed" description="${description}">\nimages: 0\n\nThe script failed.\n</geerun>`,
      metadata: { source: 'geerun', callID: 'call_gee', task: INPUT.task, state: 'completed', outcome: 'failed', ended: 4000 },
    };
    const view = geeRunView(backgrounded(), notice, false, 'en');
    expect(view.bad).toBe(true);
    expect(view.lines.at(-1)).toMatchObject({ text: 'The script failed.', tone: 'error' });
  });

  // Guards against a fork's copy of a call running for ever: its notification goes to the session that started the
  // run.
  test('a background run without its notification runs only while the list of runs has its session', () => {
    expect(geeRunView(backgrounded(), undefined, true, 'en').running).toBe(true);
    // Guards against its time counting on once it no longer runs, which a row without an end does.
    expect(geeRunView(backgrounded(), undefined, false, 'en')).toMatchObject({ running: false, bad: false, start: 1000, end: 1500 });
  });
});

// Guards against a status staying on geerun's row past its time: the row renders again only when movesOnAt says.
describe("GeoCode: when geerun's row moves on by itself", () => {
  const told = (seq: number, text: string | null): Status => ({ seq, text });

  test('a status others wait behind moves on once it has stayed its time, the sooner the more wait', () => {
    const first = firstShown([told(1, 'Reading the image')], 1000);
    const two = nextShown(first, [told(1, 'Reading the image'), told(2, 'Clipping'), told(3, 'Exporting')], 1100);
    expect(movesOnAt(two, 1100)).toBe(1800);
    const many = nextShown(first, Array.from({ length: 21 }, (_, seq) => told(seq + 1, `step ${seq}`)), 1100);
    expect(movesOnAt(many, 1100)).toBe(1200);
  });

  test('with nothing doing anything, the status gives way to the wait once it has stayed its time, and goes after', () => {
    const first = firstShown([told(1, 'Reading the image')], 1000);
    const idle = nextShown(first, [told(1, 'Reading the image'), told(2, null)], 1200);
    expect(movesOnAt(idle, 1300)).toBe(1800);
    expect(movesOnAt(idle, 1900)).toBe(2700);
    expect(movesOnAt(nextShown(idle, [], 2700), 2700)).toBeUndefined();
  });

  test('a status still being done waits for nothing', () => {
    expect(movesOnAt(firstShown([told(1, 'Reading the image')], 1000), 5000)).toBeUndefined();
  });
});
