import { describe, expect, test } from 'bun:test';

import type { Metadata, ToolPart, ToolState } from '@/lib/opencode/model';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE } from '@/sync/types';

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
});
