import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('leaves the upstream name in the git library only in internal names, never in a file, folder or ref name', () => {
    const library = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'git');
    const naming = fs.readdirSync(library)
      .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
      .flatMap((file) => fs.readFileSync(path.join(library, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /openchamber/i.test(line))
        .map((line) => `${file}: ${line}`));
    expect(naming).toEqual([
      "credential-broker.js: export const GIT_CREDENTIAL_NONCE_ENV = 'OPENCHAMBER_GIT_CREDENTIAL_NONCE';",
      "credential-broker.js: const nonce = request.headers['x-openchamber-git-nonce'];",
      "credential-broker.js: const operation = request.headers['x-openchamber-git-operation'];",
      'credential-helper.js: const nonce = process.env.OPENCHAMBER_GIT_CREDENTIAL_NONCE;',
      "credential-helper.js: 'x-openchamber-git-nonce': nonce,",
      "credential-helper.js: 'x-openchamber-git-operation': operation,",
      // Overridden by the shell with a folder in its data directory.
      "credential-resolver.js: snapshotRoot = path.join(os.tmpdir(), 'openchamber-git-ssh'),",
      "identity-storage.js: const legacyDataDir = () => path.join(os.homedir(), '.config', 'openchamber');",
      'identity-storage.js: const dataDir = process.env.OPENCHAMBER_DATA_DIR',
      'identity-storage.js: ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)',
      'network-operations.js: `OPENCHAMBER_GIT_SSH_KEY=${shellQuote(privateKeyPath)} ${helperShellCommand(SSH_WRAPPER_PATH)}`;',
      "network-operations.js: 'GIT_PROXY_COMMAND', 'SSH_AUTH_SOCK', 'OPENCHAMBER_GIT_SSH_KEY',",
      'network-operations.js: env.OPENCHAMBER_GIT_SSH_KEY = credential.key.privateKeyPath;',
      "network-operations.js: id: recordId, initiator: 'user', executorKind: 'openchamber-server-git', runtime: runtimeIdentity,",
      "network-operations.js: if (context.env.OPENCHAMBER_GIT_SSH_KEY) throw operationError('AUTHENTICATION_REQUIRED', 'The LFS upload grant requires an HTTPS credential', 409);",
      "network-operations.js: '-c', `remote.openchamber-lfs.url=${endpoint.endpoint}`,",
      "network-operations.js: 'lfs', 'push', '--object-id', 'openchamber-lfs', ...pointers.map((pointer) => pointer.oid),",
      "network-operations.js: executorKind: 'openchamber-server-git',",
      "repository-credential-runtime.js: throw new Error('OpenChamber listener port is unavailable for the Git credential helper');",
      'service.js: const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]',
      "service.js: const tmpParent = path.join(process.env.OPENCHAMBER_DATA_DIR ? path.resolve(process.env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'), 'tmp');",
      'ssh-wrapper.js: const keyPath = process.env.OPENCHAMBER_GIT_SSH_KEY;',
    ]);
  });
});
