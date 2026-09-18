/* --- GeoCode: guards against the goal auditor's system prompt, which decides what counts as evidence that a
 * goal is met, framing the work as a coding agent's again (docs/DESKTOP.md §7.3). --- */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/session-goal/runtime.js'),
  'utf8',
);

describe('session goal auditor prompt', () => {
  it('does not tell the auditor it is judging a coding agent', () => {
    const line = source.split('\n').find((entry) => entry.includes('You audit progress of'));
    // A "does not contain" assertion alone passes on a prompt renamed out from under it.
    expect(line).toBeDefined();
    expect(line.toLowerCase()).not.toContain('coding');
    expect(source).toContain('"verdict": "continue" | "complete" | "blocked"');
  });
});
