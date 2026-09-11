/* --- GeoCode: the renderer composes the chats root itself, in four places (docs/PATHS.md §5).
 * Any one of them going back to upstream's `.config/openchamber/chats` in a merge conflicts with
 * nothing: the create path would put GeoCode's chats in another product's directory, and the
 * classifiers would stop recognising the ones it did create. --- */
import { afterEach, describe, expect, test } from 'bun:test';

import { opencodeClient } from '@/lib/opencode/client';
import { createChatDirectory, getChatsRootForHome, isChatDirectoryForHome, isChatDirectoryPath } from '../lib/chatDirectories';
import { CHATS_SEGMENTS } from './shell-data-root';

const HOME = '/Users/tester';
const ROOT = `${HOME}/${CHATS_SEGMENTS.join('/')}`;
const OURS = `${ROOT}/2026-08-21/session-a`;
const OPENCHAMBER = `${HOME}/.config/openchamber/chats/2026-08-21/session-a`;

const original = {
  getFilesystemHome: opencodeClient.getFilesystemHome,
  createDirectory: opencodeClient.createDirectory,
};

afterEach(() => {
  opencodeClient.getFilesystemHome = original.getFilesystemHome;
  opencodeClient.createDirectory = original.createDirectory;
});

describe('chat directories', () => {
  test('creates a chat under the shell data root', async () => {
    const created: string[] = [];
    opencodeClient.getFilesystemHome = async () => HOME;
    opencodeClient.createDirectory = async (path: string) => {
      created.push(path);
      return { success: true, path };
    };
    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));
    expect(directory.startsWith(`${ROOT}/2026-08-21/session-`)).toBe(true);
    expect(created).toEqual([directory]);
  });

  test('recognises its own chats and not OpenChamber\'s', () => {
    expect(getChatsRootForHome(HOME)).toBe(ROOT);
    expect(isChatDirectoryForHome(OURS, HOME)).toBe(true);
    expect(isChatDirectoryPath(OURS)).toBe(true);
    expect(isChatDirectoryForHome(OPENCHAMBER, HOME)).toBe(false);
    expect(isChatDirectoryPath(OPENCHAMBER)).toBe(false);
  });
});
