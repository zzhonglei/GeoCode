import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { migrateLegacyUserDirs } from '../lib/data-dir-migration.js';
import { discoverLoopFiles } from '../lib/scheduled-tasks/loops.js';
import { getClaudeCliAuthStatus } from '../lib/opencode/claude-cli-auth.js';
import { createProjectConfigRuntime } from '../lib/projects/project-config.js';
import { getProfiles } from '../lib/git/identity-storage.js';

// Guards against the shell taking data, tasks, logins or commands from OpenChamber, other agent tools
// or a file checked into a project.
const savedHome = process.env.HOME;
let root;
let home;
let repo;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-foreign-reads-'));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  process.env.HOME = home;
  for (const dir of [path.join(home, '.config', 'openchamber', 'projects'), path.join(home, '.agents', 'loops'), path.join(repo, '.agents', 'loops'), path.join(repo, '.openchamber')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(home, '.config', 'openchamber', 'projects', 'p.json'), '{}\n');
  for (const dir of [path.join(home, '.agents', 'loops'), path.join(repo, '.agents', 'loops')]) {
    fs.writeFileSync(path.join(dir, 'nightly.md'), '---\nname: nightly\nschedule: "0 3 * * *"\n---\nRun.\n');
  }
  fs.writeFileSync(path.join(repo, '.openchamber', 'project.json'), `${JSON.stringify({ version: 1, 'setup-worktree': ['echo shared'], actions: [{ id: 'a', name: 'Shared', command: 'echo action' }] })}\n`);
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: foreign reads', () => {
  it('copies nothing from OpenChamber\'s data directory', async () => {
    const dataDir = path.join(root, 'data');
    expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot: path.join(home, '.config', 'openchamber') })).toEqual([]);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('imports no git identities from OpenChamber\'s data directory', () => {
    const theirs = path.join(home, '.config', 'openchamber');
    fs.writeFileSync(path.join(theirs, 'git-identities.json'), `${JSON.stringify({ profiles: [{ id: 'theirs', name: 'theirs', userName: 'theirs', userEmail: 'theirs@example.com' }] })}\n`);
    const before = fs.readdirSync(theirs).sort();
    const savedDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = path.join(root, 'identities');
    try {
      expect(getProfiles()).toEqual([]);
    } finally {
      if (savedDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = savedDataDir;
    }
    expect(fs.readdirSync(theirs).sort()).toEqual(before);
  });

  it('finds no loops in .agents', () => {
    expect(discoverLoopFiles(repo)).toEqual([]);
  });

  it('never runs the claude command', () => {
    const spawnSyncFn = vi.fn(() => ({ stdout: '{"loggedIn":true}', status: 0 }));
    expect(getClaudeCliAuthStatus({ spawnSyncFn }).connected).toBe(false);
    expect(spawnSyncFn).not.toHaveBeenCalled();
  });

  it('takes no setup commands or plans folder from a checked-in project file', async () => {
    const runtime = createProjectConfigRuntime({ fsPromises, path, projectsDirPath: path.join(root, 'projects') });
    const projectID = `path_${Buffer.from(repo).toString('base64url')}`;
    const setup = await runtime.readProjectSetup(projectID);
    expect(setup.shared).toMatchObject({ status: 'missing' });
    expect(JSON.stringify(setup)).not.toContain('echo');
    expect(await runtime.resolveSharedPlansDir(projectID)).toBe(null);
  });
});
