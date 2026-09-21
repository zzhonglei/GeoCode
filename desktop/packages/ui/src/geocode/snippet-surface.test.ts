/* --- GeoCode: closing the picker is not enough; the caret trigger has to close too, or the composer thinks an
 * autocomplete is open while nothing is on screen (docs/DESKTOP.md §7.3). --- */
import { describe, expect, mock, test } from 'bun:test';

let desktop = false;
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => desktop }));

const { resolveAutocompleteTrigger } = await import('@/components/chat/composer/language/triggers');

// A bare `#` is enough on its own, so the cases start there rather than at a typed name.
const kindFor = (value: string) =>
  resolveAutocompleteTrigger(value, value.length, { inputMode: 'normal', mentionsEnabled: true })?.kind ?? null;

const CASES = ['#', '#include', 'see #note'] as const;

describe('the snippet trigger', () => {
  test('asks for nothing in the desktop shell, where no picker can answer', () => {
    desktop = true;
    expect(CASES.map((value) => [value, kindFor(value)])).toEqual(CASES.map((value) => [value, null]));
  });

  test('still works everywhere the picker is offered', () => {
    desktop = false;
    expect(CASES.map((value) => [value, kindFor(value)])).toEqual(CASES.map((value) => [value, 'snippet']));
  });

  test('leaves the other triggers alone in the desktop shell', () => {
    desktop = true;
    expect([kindFor('/hel'), kindFor('@fi')]).toEqual(['command', 'mention']);
  });
});
