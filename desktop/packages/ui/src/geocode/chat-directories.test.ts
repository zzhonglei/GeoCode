/* --- GeoCode: the renderer's own chats root (docs/PATHS.md §5).
 *
 * Upstream v1.23 moved the configured root to the server, which answers `/api/fs/home` with it,
 * and kept one literal on this side: the fallback the module uses when that answer omits it —
 * and which every classifier here also accepts as a root of ours. Upstream spells that fallback
 * `.config/openchamber/chats`, so leaving it would both put new chats in another product's
 * directory whenever the server stays quiet and make that product's chats read as GeoCode's.
 *
 * The fallback is what the first case reads directly; the rest drive the module through the
 * server answer that triggers it. --- */
import { afterEach, describe, expect, test } from 'bun:test';

import { opencodeClient } from '@/lib/opencode/client';
import { createChatDirectory, getChatsRootForHome, isChatDirectoryForHome, isChatDirectoryPath } from '../lib/chatDirectories';
import { CHATS_SEGMENTS } from './shell-data-root';

const HOME = '/Users/tester';
const ROOT = `${HOME}/${CHATS_SEGMENTS.join('/')}`;
const OURS = `${ROOT}/2026-08-21/session-a`;
const OPENCHAMBER = `${HOME}/.config/openchamber/chats/2026-08-21/session-a`;

const original = {
  getFilesystemHomeInfo: opencodeClient.getFilesystemHomeInfo,
  createDirectory: opencodeClient.createDirectory,
};

afterEach(() => {
  opencodeClient.getFilesystemHomeInfo = original.getFilesystemHomeInfo;
  opencodeClient.createDirectory = original.createDirectory;
});

describe('chat directories', () => {
  // First, before anything below fills the module's per-runtime cache: with nothing cached
  // this reads the fallback and nothing else.
  test('falls back to the shell data root, not to the other product', () => {
    const root = getChatsRootForHome(HOME);
    expect(root).toBe(ROOT);
    expect(root).not.toContain('openchamber');
  });

  test('creates a chat under the shell data root when the server names none', async () => {
    const created: string[] = [];
    opencodeClient.getFilesystemHomeInfo = async () => ({ home: HOME });
    opencodeClient.createDirectory = async (path: string) => {
      created.push(path);
      return { success: true, path };
    };
    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));
    expect(directory.startsWith(`${ROOT}/2026-08-21/session-`)).toBe(true);
    expect(created).toEqual([directory]);
  });

  test('recognises its own chats and not the ones of the other product', () => {
    expect(isChatDirectoryForHome(OURS, HOME)).toBe(true);
    expect(isChatDirectoryPath(OURS)).toBe(true);
    expect(isChatDirectoryForHome(OPENCHAMBER, HOME)).toBe(false);
    expect(isChatDirectoryPath(OPENCHAMBER)).toBe(false);
  });
});
