import { describe, expect, test } from 'bun:test';

import type { Metadata, SyntheticMessage, ToolPart, ToolState } from '@/lib/opencode/model';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE } from '@/sync/types';

import { geeRunNotice, geeRunView } from './geeRun';

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

/** As the kernel's `notification` puts the end of a run in the background into the conversation. */
const notice = (metadata: Metadata, text: string): SyntheticMessage => ({
  id: 'msg_notice',
  sessionID: 'ses_1',
  role: 'synthetic',
  time: { created: 9000 },
  text: `<geerun task="taipei-rgb-20261012" state="${String(metadata.state)}" description="NDVI > 0.3">\n${text}\n</geerun>`,
  metadata: { source: 'geerun', callID: 'call_gee', ...metadata },
});

describe("GeoCode: geerun's row", () => {
  // Guards against a row left running by its answer never ending, ending on another call's notice, or ending otherwise
  // than its notice says; the notices are as the kernel words them.
  test('a run in the background runs until the notice of its end, and ends as the notice says', () => {
    expect(geeRunView(backgrounded(), undefined, 'en')).toMatchObject({ running: true, bad: false, end: undefined });

    const done = notice(
      { state: 'completed', outcome: 'finished', started: 1000, ended: 8000, log: 'images: 73\n' },
      'Task taipei-rgb-20261012: 1 asset.\n\nimages: 73\n\nFinished in 7 s.',
    );
    expect(geeRunNotice([{ ...done, metadata: { ...done.metadata, callID: 'call_other' } }], 'call_gee')).toBeUndefined();
    expect(geeRunNotice([done], 'call_gee')).toBe(done);
    const finished = geeRunView(backgrounded(), done, 'en');
    expect(finished).toMatchObject({ running: false, bad: false, start: 1000, end: 8000 });
    expect(finished.lines.map((line) => line.text)).toEqual(['images: 73', 'Finished in 7 s.']);

    const failed = notice({ state: 'error', started: 1000, log: 'half\n' }, 'GeoEngine stopped.\nRestart GeoCode.');
    expect(geeRunView(backgrounded(), failed, 'en')).toMatchObject({ running: false, bad: true, end: 9000 });
  });

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
});
