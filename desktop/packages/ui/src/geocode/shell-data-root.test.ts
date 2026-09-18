/* --- GeoCode: the renderer's shell data root must keep its value, so it and the shell runtime cannot drift together
 * into a shared wrong root; their agreement is asserted in electron/geocode/shell-data-root.test.mjs
 * (docs/PATHS.md §3.3). --- */
import { describe, expect, test } from 'bun:test';

import { CHATS_SEGMENTS, SHELL_DATA_ROOT_SEGMENTS } from './shell-data-root';

describe('shell data root', () => {
  test('chats hang off the one root', () => {
    expect(CHATS_SEGMENTS).toEqual([...SHELL_DATA_ROOT_SEGMENTS, 'chats']);
  });

  test('names GeoCode, and no longer names OpenChamber', () => {
    expect(SHELL_DATA_ROOT_SEGMENTS).toEqual(['.config', 'GeoCode', 'desktop']);
    expect(CHATS_SEGMENTS.join('/')).toBe('.config/GeoCode/desktop/chats');
    expect(CHATS_SEGMENTS.join('/')).not.toContain('openchamber');
  });
});
