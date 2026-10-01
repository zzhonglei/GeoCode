import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards against a merge restoring OpenChamber's OAuth application, under whose name the user would authorize,
// or the permission to edit workflow files.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-github-app-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
delete process.env.OPENCHAMBER_GITHUB_CLIENT_ID;
delete process.env.OPENCHAMBER_GITHUB_SCOPES;
const { getGitHubClientId, getGitHubScopes } = await import('../lib/github/auth.js');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('GeoCode: GitHub sign-in', () => {
  it('uses its own OAuth application', () => {
    expect(getGitHubClientId()).toBe('Ov23liGGsghsdLRXeIil');
  });

  it('does not ask to edit workflow files', () => {
    expect(getGitHubScopes().split(' ')).not.toContain('workflow');
  });
});
