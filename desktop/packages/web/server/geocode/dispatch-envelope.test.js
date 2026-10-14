import { describe, expect, it } from 'vitest';

import { buildDispatchResultMessage } from '../lib/dispatch-results/runtime.js';
import { readDispatchedSessionResult } from '../../../ui/src/lib/opencode/dispatched-session.ts';

// Guards against the server and the interface naming the result envelope differently, which shows the envelope in the chat.
describe('GeoCode: dispatched session envelope', () => {
  it('is unwrapped by the interface as the server writes it', () => {
    const written = buildDispatchResultMessage({ sessionId: 'ses_1', title: 'Survey', outcome: { state: 'completed', text: 'All done.' } });
    const message = { role: 'synthetic', text: written.text, metadata: written.metadata, time: { created: 1 } };
    expect(readDispatchedSessionResult(message)?.output).toBe('All done.');
  });
});
