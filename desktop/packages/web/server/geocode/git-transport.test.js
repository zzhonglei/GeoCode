import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureRepositoryTransport } from '../lib/git/service.js';
import { managedSshCommand } from '../lib/git/network-operations.js';

const roots = [];
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
const repository = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-git-transport-'));
  roots.push(repo);
  git(repo, ['init', '-q']);
  return repo;
};
const sshCommand = (repo) => {
  try {
    return git(repo, ['config', '--local', '--get', 'core.sshCommand']).trim();
  } catch {
    return null;
  }
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode: the SSH command it writes into a repository', () => {
  // OpenChamber's wrapper has the same file name: unbinding in GeoCode must not remove the command OpenChamber wrote.
  it('removes only its own when the binding is cleared', async () => {
    const repo = repository();
    const openchamber = "OPENCHAMBER_GIT_SSH_KEY='/Users/u/.config/openchamber/key' '/Applications/OpenChamber.app/node' '/Applications/OpenChamber.app/ssh-wrapper.js'";
    git(repo, ['config', '--local', 'core.sshCommand', openchamber]);
    await configureRepositoryTransport(repo);
    expect(sshCommand(repo)).toBe(openchamber);

    await configureRepositoryTransport(repo, { sshCommand: managedSshCommand('/data/geocode/key') });
    await configureRepositoryTransport(repo);
    expect(sshCommand(repo)).toBe(null);
  });
});
