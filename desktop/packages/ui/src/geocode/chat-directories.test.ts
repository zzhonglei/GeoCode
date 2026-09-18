/* --- GeoCode: the renderer's fallback chats root must not be upstream's `.config/openchamber/chats`, which would put
 * new chats in another product's directory and read that product's chats as GeoCode's (docs/PATHS.md §5). --- */
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
