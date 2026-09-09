/* --- GeoCode: a worktree branch the caller did not name carries our name, not upstream's
 * (docs/PATHS.md §3.2, geocode/kernel-roots.js).
 *
 * The worktree directory sits under our own data root, but the branch is created in the user's
 * repository — `git branch` lists it and a push publishes it — so it is the one half of this
 * feature that writes another product's name into their data. The line had no coverage at all:
 * every existing test passes `branchName` explicitly, which is also why the entry points in the
 * app never reach it. A real repository is used because the name only appears once git has
 * created the branch. --- */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WORKTREE_BRANCH_PREFIX } from './kernel-roots.js';

const tempDirs = [];
const saved = {};

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-worktree-branch-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const createRepository = () => {
  const repository = createTempDir();
  runGit(repository, ['init', '-b', 'main']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  return repository;
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('worktree branch prefix', () => {
  it('is our name', () => {
    expect(WORKTREE_BRANCH_PREFIX).toBe('geocode/');
  });

  it('is what git records when the caller names no branch', async () => {
    const dataHome = createTempDir();
    for (const key of ['XDG_DATA_HOME']) saved[key] = process.env[key];
    process.env.XDG_DATA_HOME = dataHome;

    const repository = createRepository();
    const { createWorktree } = await import('../lib/git/service.js');
    // Not `returnAfterDirectoryCreated`: that returns before git has attached the worktree,
    // and the branch is what this asserts.
    await createWorktree(repository, { mode: 'new', worktreeName: 'side-task' });

    const branches = runGit(repository, ['branch', '--list', '--format=%(refname:short)'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(branches).toContain(`${WORKTREE_BRANCH_PREFIX}side-task`);
    expect(branches.filter((branch) => branch.startsWith('openchamber/'))).toEqual([]);
  });
});
