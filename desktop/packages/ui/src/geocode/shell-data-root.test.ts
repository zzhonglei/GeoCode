/* --- GeoCode: the renderer and the shell runtime must land on the same data root
 * (docs/PATHS.md §3.3).
 *
 * The round trip is the point, and it is a cross-package one. Every server-side reader is
 * TOLD the root through `OPENCHAMBER_DATA_DIR`; the renderer cannot be told and rebuilds it
 * from the home directory. So the two are only equal by agreement, and nothing else in the
 * tree checks that agreement — which is how an earlier pass moved the injection to an
 * Electron userData path while these segments still named OpenChamber's directory, leaving
 * GeoCode creating chats inside another product's config while the server looked for them
 * somewhere else entirely (PATHS.md §5).
 *
 * The agreement itself is asserted from the other side, in `electron/geocode/shell-data-root.test.mjs`:
 * that package has no `tsc` pass to satisfy, so it can import this module and call the injection
 * directly. What is pinned HERE is the value, so the two cannot drift together into a shared wrong
 * answer. --- */
import { describe, expect, test } from 'bun:test';

import { CHATS_SEGMENTS, MANAGED_CHATS_PATH_SEGMENT, PROJECTS_SEGMENTS, SHELL_DATA_ROOT_SEGMENTS } from './shell-data-root';

describe('shell data root', () => {
  test('chats and per-project config hang off the one root', () => {
    // A root that moved without its children is the shape of the bug this file exists for.
    expect(CHATS_SEGMENTS).toEqual([...SHELL_DATA_ROOT_SEGMENTS, 'chats']);
    expect(PROJECTS_SEGMENTS).toEqual([...SHELL_DATA_ROOT_SEGMENTS, 'projects']);
  });

  test('the substring test used to classify a chat directory is bounded by separators', () => {
    // It stands in for "is this one of ours" across the session sidebar, the header, and the
    // persistence cache. Unbounded, it would also match a project directory that merely ends
    // in the same name.
    expect(MANAGED_CHATS_PATH_SEGMENT).toBe(`/${CHATS_SEGMENTS.join('/')}/`);
    expect(MANAGED_CHATS_PATH_SEGMENT.startsWith('/')).toBe(true);
    expect(MANAGED_CHATS_PATH_SEGMENT.endsWith('/')).toBe(true);
  });

  test('names GeoCode, and no longer names OpenChamber', () => {
    // The literals, pinned once here so the derivations above cannot all agree on a wrong
    // value. `.config/GeoCode` alone is the KERNEL's config root, so the `desktop` segment is
    // load-bearing: a case-insensitive filesystem folds `geocode` into it.
    expect(SHELL_DATA_ROOT_SEGMENTS).toEqual(['.config', 'GeoCode', 'desktop']);
    expect(MANAGED_CHATS_PATH_SEGMENT).toBe('/.config/GeoCode/desktop/chats/');
    expect(MANAGED_CHATS_PATH_SEGMENT).not.toContain('openchamber');
  });
});
