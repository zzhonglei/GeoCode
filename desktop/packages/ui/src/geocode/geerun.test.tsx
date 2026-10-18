import { describe, expect, test } from 'bun:test';

import type { Message, Metadata, SyntheticMessage, ToolPart, ToolState } from '@/lib/opencode/model';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { materializeSessionSnapshots } from '@/sync/materialization';
import { INITIAL_STATE } from '@/sync/types';

import { geeRunView } from './geeRun';

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
  test('a background run ends as its notification says, whatever lines and quotes its description holds', () => {
    const description = '下载台北真彩色影像\n并导出 "RGB"';
    const notice: SyntheticMessage = {
      id: 'msg_notice',
      sessionID: 'ses_1',
      role: 'synthetic',
      time: { created: 5000 },
      description,
      text: `<geerun task="${INPUT.task}" state="completed" description="${description}">\nimages: 0\n\nThe script failed.\n</geerun>`,
      metadata: { source: 'geerun', callID: 'call_gee', task: INPUT.task, state: 'completed', outcome: 'failed', ended: 4000 },
    };
    const view = geeRunView(backgrounded(), notice, 'en');
    expect(view.bad).toBe(true);
    expect(view.lines.at(-1)).toMatchObject({ text: 'The script failed.', tone: 'error' });
  });

  // Guards against a call the interface closed itself, as its turn ended, ending its row otherwise than one the kernel
  // interrupted: the words for it are the interface's own.
  test('a call the interface closed as its turn ended ends as one the kernel interrupted', () => {
    const metadata = { started: 1000, statuses: [], log: '' };
    const turn: Message = {
      id: 'msg_a',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 900, completed: 13000 },
      modelID: 'model',
      providerID: 'provider',
      agent: 'agent',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const running = call({ status: 'running', input: INPUT, metadata, time: { start: 900 } });
    const closed = materializeSessionSnapshots({ message: {}, part: {} }, 'ses_1', [{ info: turn, parts: [running] }]).part
      .msg_a[0];
    const interrupted = call({ status: 'error', input: INPUT, error: 'Tool execution interrupted', metadata, time: { start: 900, end: 13000 } });
    expect(closed?.type === 'tool' && geeRunView(closed, undefined, 'en').lines).toEqual(geeRunView(interrupted, undefined, 'en').lines);
  });
});
