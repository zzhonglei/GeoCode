import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { deleteChatDirectory, ensureChatsRootDirectory, isChatDirectoryForHome } from '@/lib/chatDirectories';

let runtime = 0;
const home = spyOn(opencodeClient, 'getFilesystemHomeInfo');
const request = spyOn(globalThis, 'fetch');
const openchamberChat = '/home/fixture/.config/openchamber/chats/2026-10-18/session-a';
const deletions = () => request.mock.calls.filter(([input]) => String(input).includes('/fs/delete'));

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:1', runtimeKey: `geocode-chats-${++runtime}` });
  home.mockReset();
  request.mockReset();
  home.mockResolvedValue({ home: '/home/fixture', chatsRoot: '/geo/chats' });
  request.mockResolvedValue(new Response('{}'));
});
afterAll(() => {
  home.mockRestore();
  request.mockRestore();
});

// Deleting a chat's last session removes its folder: OpenChamber's chats must never be taken for GeoCode's.
test('never treats OpenChamber chats as its own, so never deletes them', async () => {
  expect(isChatDirectoryForHome(openchamberChat, '/home/fixture')).toBe(false);
  await ensureChatsRootDirectory();
  expect(isChatDirectoryForHome(openchamberChat, '/home/fixture')).toBe(false);
  await deleteChatDirectory(openchamberChat);
  expect(deletions()).toHaveLength(0);
  await deleteChatDirectory('/geo/chats/2026-10-18/session-a');
  expect(deletions()).toHaveLength(1);
});
