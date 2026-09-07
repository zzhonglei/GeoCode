/* --- GeoCode: the goal auditor's system prompt reaches the model verbatim and so carries no marker of
 * its own; this file is the marker (CONVENTIONS.md §5).
 *
 * It catches the word, not the intent. The auditor is the only authority that can settle a goal —
 * the working agent has no channel to declare its own objective met — so what that prompt treats as
 * evidence decides when the loop stops spending. Framed as judging a coding agent, it looks for
 * code-shaped proof; a GeoCode goal is met by reprojected files, coordinate systems and verified
 * outputs. Same shape and same reasoning as the compaction prompt (KERNEL.md §5.2), which is the
 * other place one word decided what counts. Asserted against the source text because the builder is
 * upstream's own local function: exporting it would rewrite an upstream line for nothing. --- */
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
