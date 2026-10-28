import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotWorktree } from '../lib/git/service.js';

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
});
