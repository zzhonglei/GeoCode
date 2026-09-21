/* --- GeoCode: the loading mark is inlined in three places that no compiler or merge links together,
 * so a change to one has to reach the others (docs/DESKTOP.md §7.2). --- */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const SPLASHES = ['packages/electron/main.mjs', 'packages/web/index.html'] as const;
const COMPONENT = 'packages/ui/src/geocode/GeoCodeBrandMark.tsx';

const read = (file: string) => readFileSync(path.join(DESKTOP, file), 'utf8');

// Anchored on our own orbit variable rather than on any upstream wording, so reworded labels do not
// move the anchor and a second mark pasted into the same file is still seen.
const marksIn = (text: string): string[] =>
  (text.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/g) ?? []).filter((mark) => mark.includes('var(--geocode-orbit)'));

const openingTag = (mark: string) => /^<svg\b[^>]*>/.exec(mark)?.[0] ?? '';
const body = (mark: string) => mark.slice(openingTag(mark).length, -'</svg>'.length);
// The label names the product and differs by host; everything else about the tag decides how it renders.
const shape = (mark: string) => openingTag(mark).replace(/\s*aria-label="[^"]*"/, '');

const literal = (text: string, name: string) =>
  new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(text)?.[1] ?? null;

const anchorCall = (text: string) => /setCurrentTime\(\(Date\.now\(\)[^;]*\);/.exec(text)?.[0] ?? null;

const clockScripts = (text: string) =>
  (text.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []).filter((block) => block.includes('setCurrentTime'));

const orbitColours = (text: string) =>
  [...new Set(text.match(/#(?:5A6874|A8B5C1)/gi) ?? [])].map((c) => c.toUpperCase()).sort();

// The still master carries a further scale, so a surface that falls back to it shrinks the mark
// mid-handoff. Both lines below are upstream's, which a merge can restore without any conflict.
const SURFACES = [
  ['packages/ui/src/App.tsx', 'AppStartupOverlay', 'animated'],
  ['packages/ui/src/components/auth/SessionAuthGate.tsx', 'OpenChamberLogo', 'isAnimated'],
] as const;

const element = (text: string, name: string) => new RegExp(`<${name}\\b[\\s\\S]*?/>`).exec(text)?.[0] ?? '';
const occurrences = (text: string, name: string) => (text.match(new RegExp(`<${name}\\b`, 'g')) ?? []).length;

describe('the startup loading surfaces draw the moving master', () => {
  for (const [file, name, prop] of SURFACES) {
    test(`${file} asks for it`, () => {
      // Counted as well as read: a second one of these would leave the reader pinning the wrong line.
      expect([occurrences(read(file), name), element(read(file), name).includes(prop)]).toEqual([1, true]);
    });
  }
});

describe('the loading mark is one artwork', () => {
  test('each splash inlines it exactly once', () => {
    const counts = SPLASHES.map((file) => `${file}: ${marksIn(read(file)).length}`);
    expect(counts).toEqual(SPLASHES.map((file) => `${file}: 1`));
  });

  test('the bodies are identical, component included', () => {
    const bodies = [...SPLASHES.map((f) => body(marksIn(read(f))[0])), literal(read(COMPONENT), 'ANIMATED_BODY')];
    expect(bodies.every((b) => typeof b === 'string' && b.length > 0)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
  });

  test('the splashes render it at the same size', () => {
    expect(new Set(SPLASHES.map((f) => shape(marksIn(read(f))[0]))).size).toBe(1);
  });

  test('the component draws on the same canvas', () => {
    const tag = /<svg[\s\S]*?viewBox="([^"]*)"/.exec(read(COMPONENT))?.[1];
    expect(tag).toBe(/viewBox="([^"]*)"/.exec(shape(marksIn(read(SPLASHES[0]))[0]))?.[1]);
  });

  test('all three define the same pair of orbit colours', () => {
    const sets = [...SPLASHES, COMPONENT].map((f) => orbitColours(read(f)).join(' '));
    expect(sets[0]).toBe('#5A6874 #A8B5C1');
    expect(new Set(sets).size).toBe(1);
  });

  // Three stages, three SMIL clocks, each starting at zero: whichever stage lacks the wall-clock anchor
  // is the one the star jumps at. Picked out by what it calls, so reformatting does not move the anchor.
  test('both splashes anchor the clock, with the same code', () => {
    const blocks = SPLASHES.map((f) => clockScripts(read(f)));
    expect(blocks.map((b) => b.length)).toEqual([1, 1]);
    expect(new Set(blocks.map((b) => b[0])).size).toBe(1);
  });

  // The expression is taken from the splash rather than spelled out here, so the component is held
  // against what actually ships. Naming the call alone would not do: the guard names it too, so an
  // assertion on the name stays green while the call itself is gone.
  test('the component anchors it the same way', () => {
    const fromSplash = anchorCall(clockScripts(read(SPLASHES[0]))[0]);
    expect([fromSplash !== null, anchorCall(read(COMPONENT))]).toEqual([true, fromSplash]);
  });

  test('the still mark is wired to the same colour', () => {
    const still = literal(read(COMPONENT), 'STATIC_BODY');
    expect(still).toContain('var(--geocode-orbit)');
  });
});

// Each mutation is applied to the source text and put back through the readers above, which is what
// proves the readers move with the source rather than that two strings differ.
describe('a drifted copy is caught', () => {
  const main = read(SPLASHES[0]);
  const index = read(SPLASHES[1]);
  const component = read(COMPONENT);

  test('a resized canvas', () => {
    const drifted = main.replace('viewBox="0 0 100 100"', 'viewBox="0 0 140 140"');
    expect(drifted).not.toBe(main);
    expect(shape(marksIn(drifted)[0])).not.toBe(shape(marksIn(main)[0]));
  });

  test('a moved path', () => {
    const drifted = index.replace('rx="58.0" ry="15.2"', 'rx="58.0" ry="15.3"');
    expect(drifted).not.toBe(index);
    expect(body(marksIn(drifted)[0])).not.toBe(body(marksIn(index)[0]));
  });

  test('a recoloured orbit', () => {
    const drifted = component.replace('#A8B5C1', '#FF0000');
    expect(drifted).not.toBe(component);
    expect(orbitColours(drifted)).not.toEqual(orbitColours(component));
  });

  test('a startup surface dropped back to the still master', () => {
    const [file, name, prop] = SURFACES[0];
    const source = read(file);
    const drifted = source.replace(` ${prop} />`, ' />');
    // Compared as flags rather than as text: these files are large enough that a failed identity
    // assertion would bury the reason under the whole source.
    expect([drifted === source, element(drifted, name).includes(prop)]).toEqual([false, false]);
  });

  test('a splash that lost the clock anchor', () => {
    // Every occurrence: the guard names the call too, so replacing only the call leaves the block matching.
    const drifted = main.replaceAll('setCurrentTime', 'noSuchCall');
    expect([drifted === main, clockScripts(drifted).length]).toEqual([false, 0]);
  });

  test('the two splashes anchoring it differently', () => {
    const drifted = index.replace('(Date.now() / 1000) % period', '(Date.now() / 2000) % period');
    expect([drifted === index, clockScripts(drifted)[0] === clockScripts(main)[0]]).toEqual([false, false]);
  });

  test('a second mark pasted in', () => {
    const drifted = index.replace('</body>', '<svg><g stroke="var(--geocode-orbit)"/></svg></body>');
    expect(drifted).not.toBe(index);
    expect(marksIn(drifted).length).toBe(2);
  });
});
