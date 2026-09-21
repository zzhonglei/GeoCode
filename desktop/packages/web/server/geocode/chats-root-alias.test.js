/* --- GeoCode: `/api/fs/home` also reports a legacy chats alias, and the renderer accepts anything it names
 * as our own chats root (ui/src/lib/chatDirectories.ts). Upstream's literal named another product's root
 * (docs/PATHS.md §5). --- */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { registerFsRoutes } from '../lib/fs/routes.js';

// The root is arbitrary on purpose: what is asserted is that the alias follows it, which no fixed
// literal can satisfy. Upstream derived the alias from the home directory instead.
const CONFIG_ROOT = '/tmp/geocode-alias-check/data-root';
const HOME = '/home/user';

const homeInfo = async () => {
  const routes = new Map();
  const app = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  registerFsRoutes(app, {
    os: { homedir: () => HOME },
    path: path.posix,
    fsPromises: { realpath: async (target) => target, stat: async () => ({ isDirectory: () => true }) },
    spawn: () => {},
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: CONFIG_ROOT,
  });
  let payload = null;
  await routes.get('GET /api/fs/home')({}, { status() { return this; }, json(body) { payload = body; return this; } });
  return payload;
};

describe('the chats roots reported to the renderer', () => {
  it('keeps every root under the configured data root', async () => {
    const { chatsRoot, canonicalChatsRoot, canonicalLegacyChatsRoot } = await homeInfo();
    const roots = { chatsRoot, canonicalChatsRoot, canonicalLegacyChatsRoot };
    for (const [name, value] of Object.entries(roots)) {
      expect([name, typeof value === 'string' && value.startsWith(`${CONFIG_ROOT}/`)]).toEqual([name, true]);
    }
  });

  it('names no other product, whatever the home directory holds', async () => {
    const payload = await homeInfo();
    const named = Object.values(payload).filter((value) => typeof value === 'string');
    expect(named.filter((value) => value.includes('openchamber'))).toEqual([]);
  });
});
