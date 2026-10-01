import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotWorktree } from '../lib/git/service.js';

// Guards against the UI's run snapshot refs (lib/multirun/keep.ts) and the server's accepted ones drifting apart,
// and against OpenChamber's name on what the app leaves in a user's repository.
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
  it('keeps run snapshots under refs/geocode, authored by GeoCode', async () => {
    const repo = repository();
    fs.writeFileSync(path.join(repo, 'README.md'), '# Changed\n');
    const ref = 'refs/geocode/runs/group-1/ses_abc';
    const result = await snapshotWorktree(repo, { ref });
    expect(git(repo, ['rev-parse', ref]).trim()).toBe(result.commit);
    expect(git(repo, ['log', '-1', '--format=%an <%ae> %cn <%ce>', result.commit]).trim()).toBe('GeoCode <snapshot@geocode.local> GeoCode <snapshot@geocode.local>');
    expect(git(repo, ['log', '-1', '--format=%s', result.commit]).trim()).toBe('GeoCode run snapshot');
  });

  it('refuses refs under OpenChamber\'s name', async () => {
    await expect(snapshotWorktree(repository(), { ref: 'refs/openchamber/runs/group-1/ses_abc' })).rejects.toThrow('Invalid snapshot ref');
  });
});
