import { beforeEach, describe, expect, mock, test } from 'bun:test';

const createdDirectories: string[] = [];
const createDirectoryOptions: Array<{ allowOutsideWorkspace?: boolean } | undefined> = [];
const deletedDirectories: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getFilesystemHome: mock(async () => '/Users/tester'),
    createDirectory: mock(async (path: string, options?: { allowOutsideWorkspace?: boolean }) => {
      createdDirectories.push(path);
      createDirectoryOptions.push(options);
      return { success: true, path };
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    deletedDirectories.push(JSON.parse(String(init?.body)).path);
    return new Response(null, { status: 200 });
  }),
}));

// GeoCode: fixtures must carry the root the code now composes (src/geocode/shell-data-root.ts)
const { CHATS_SEGMENTS } = await import('@/geocode/shell-data-root');
const chatsUnder = (home: string) => `${home}/${CHATS_SEGMENTS.join('/')}`;

const { createChatDirectory, deleteChatDirectory, getChatsRootFromDirectory, isChatDirectoryForHome, isChatDirectoryPath } = await import('./chatDirectories');

describe('chat directories', () => {
  beforeEach(() => {
    createdDirectories.length = 0;
    createDirectoryOptions.length = 0;
    deletedDirectories.length = 0;
  });

  test('creates one isolated directory beneath the dated chats root', async () => {
    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));
    expect(createdDirectories[0]).toBe(directory);
    expect(directory.startsWith(`${chatsUnder('/Users/tester')}/2026-08-21/session-`)).toBe(true);
    expect(createdDirectories).toEqual([directory]);
    expect(createDirectoryOptions).toEqual([undefined]);
  });

  test('recognizes only descendants of the managed chats root', () => {
    expect(isChatDirectoryForHome(`${chatsUnder('/Users/tester')}/2026-08-21/session-a`, '/Users/tester')).toBe(true);
    expect(isChatDirectoryForHome('/Users/tester/project', '/Users/tester')).toBe(false);
    expect(isChatDirectoryForHome(`${chatsUnder('/remote/home')}/2026-08-21/session-a`, '/Users/tester')).toBe(true);
    expect(isChatDirectoryPath(`${chatsUnder('/remote/home')}/2026-08-21/session-a`)).toBe(true);
    expect(getChatsRootFromDirectory(`${chatsUnder('/remote/home')}/2026-08-21/session-a`)).toBe(chatsUnder('/remote/home'));
  });

  test('deletes managed chat directories but leaves project directories alone', async () => {
    await deleteChatDirectory(`${chatsUnder('/Users/tester')}/2026-08-21/session-a`);
    await deleteChatDirectory('/Users/tester/project');
    expect(deletedDirectories).toEqual([`${chatsUnder('/Users/tester')}/2026-08-21/session-a`]);
  });
});
