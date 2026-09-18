/* --- GeoCode: the prompt behind a session's recap and suggested next step does not frame the agent as a coding
 * agent (docs/DESKTOP.md §7.3). --- */
import { describe, expect, it } from 'vitest';

import { buildAssistSystemPrompt } from '../lib/session-assist/prompt.js';

describe('session assist prompt', () => {
  it('does not limit suggestions to work a coding agent can do', () => {
    const prompt = buildAssistSystemPrompt({ recap: true, suggestion: true });
    // A "does not contain" assertion alone passes on a rule moved out from under it.
    expect(prompt.split('\n').some((line) => line.includes('can perform in the session'))).toBe(true);
    expect(prompt.toLowerCase()).not.toContain('coding');
  });
});
