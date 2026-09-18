/* --- GeoCode: a worktree created under Electron runs no setup commands, whoever sends them
 * (docs/DESKTOP.md §7.3). --- */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs = [];
const originalElectron = process.versions.electron;
const originalDataHome = process.env.XDG_DATA_HOME;

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-worktree-setup-'));
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

const createWorktreeAndSettle = async (name) => {
  process.env.XDG_DATA_HOME = createTempDir();
  const { createWorktree, getWorktreeBootstrapStatus } = await import('../lib/git/service.js');
  const created = await createWorktree(createRepository(), {
    mode: 'new',
    worktreeName: name,
    startCommand: 'echo ran > setup-ran.txt',
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await getWorktreeBootstrapStatus(created.path);
    if (state.status !== 'pending') return { path: created.path, state };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the worktree bootstrap did not settle');
};

afterEach(() => {
  if (originalElectron === undefined) delete process.versions.electron;
  else process.versions.electron = originalElectron;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('worktree setup commands', () => {
  it('do not run under Electron', async () => {
    process.versions.electron = '0.0.0-test';
    const { path: worktree, state } = await createWorktreeAndSettle('electron-side');
    expect(state.status).toBe('ready');
    expect(fs.existsSync(path.join(worktree, 'setup-ran.txt'))).toBe(false);
  });

  it('run without the Electron mark, so the case above reaches them', async () => {
    delete process.versions.electron;
    const { path: worktree, state } = await createWorktreeAndSettle('control-side');
    expect(state.status).toBe('ready');
    expect(fs.existsSync(path.join(worktree, 'setup-ran.txt'))).toBe(true);
  });
});
