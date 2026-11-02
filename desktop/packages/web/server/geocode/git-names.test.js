import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archiveWorktree, markGeneratedBranchName, setWorktreeTaskTitle, snapshotWorktree } from '../lib/git/service.js';

// Guards against a merge bringing OpenChamber's name back to what the app leaves in a user's repository.
const roots = [];
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });

const repository = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-git-names-'));
  roots.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init']);
  return repo;
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: git names', () => {
  it('keeps run snapshots under refs/geocode, with no upstream name on them', async () => {
    const repo = repository();
    fs.writeFileSync(path.join(repo, 'README.md'), '# Changed\n');
    const ref = 'refs/geocode/runs/group-1/ses_abc';
    const result = await snapshotWorktree(repo, { ref });
    expect(git(repo, ['rev-parse', ref]).trim()).toBe(result.commit);
    expect(git(repo, ['log', '-1', '--format=%an %ae %cn %ce %s', result.commit])).not.toMatch(/openchamber/i);
  });

  it('keeps archived worktrees under refs/geocode, with no upstream name on them', async () => {
    const repo = repository();
    const worktree = `${repo}-roads`;
    roots.push(worktree);
    git(repo, ['worktree', 'add', '-q', '-b', 'agile-chipmunk', worktree]);
    fs.writeFileSync(path.join(worktree, 'roads.geojson'), '{}\n');
    await archiveWorktree(repo, { id: 'arch_1', directory: worktree });
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/']).trim().split('\n').filter((ref) => !ref.startsWith('refs/heads/'))).toEqual(['refs/geocode/archive/arch_1']);
    expect(git(repo, ['log', '-1', '--format=%an %ae %cn %ce %B', 'refs/geocode/archive/arch_1'])).not.toMatch(/openchamber/i);
  });

  it("names the task and the generated branch under GeoCode's keys", async () => {
    const repo = repository();
    git(repo, ['switch', '-q', '-c', 'issue-180-agile-chipmunk']);
    await markGeneratedBranchName(repo, 'issue-180-agile-chipmunk', 'issue-180-');
    await setWorktreeTaskTitle(repo, { title: 'Road network', by: 'agent' });
    expect(git(repo, ['config', '--local', '--name-only', '--get-regexp', '^branch\\.']).trim().split('\n').sort()).toEqual([
      'branch.issue-180-agile-chipmunk.description',
      'branch.issue-180-agile-chipmunk.geocodeagenttitle',
      'branch.issue-180-agile-chipmunk.geocodegeneratedname',
      'branch.issue-180-agile-chipmunk.geocodegeneratedprefix',
    ]);
  });
});
