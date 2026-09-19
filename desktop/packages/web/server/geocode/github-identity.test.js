/* --- GeoCode: the registered OAuth identity must reach both device-flow requests (docs/DESKTOP.md §7.2). --- */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDeviceFlow, exchangeDeviceCode } from '../lib/github/device-flow.js';

const CLIENT_ID = 'Ov23liGGsghsdLRXeIil';
const SCOPES = 'repo read:org read:user user:email';
const keys = ['OPENCHAMBER_DATA_DIR', 'OPENCHAMBER_GITHUB_CLIENT_ID', 'OPENCHAMBER_GITHUB_SCOPES'];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let root;
let auth;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-github-identity-'));
  process.env.OPENCHAMBER_DATA_DIR = root;
  vi.resetModules();
  auth = await import('../lib/github/auth.js');
});

beforeEach(() => {
  delete process.env.OPENCHAMBER_GITHUB_CLIENT_ID;
  delete process.env.OPENCHAMBER_GITHUB_SCOPES;
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GeoCode GitHub authorization', () => {
  it('sends our client ID in both requests and omits workflow access and client secrets', async () => {
    const requests = [];
    vi.stubGlobal('fetch', async (url, options) => {
      requests.push({ url, body: Object.fromEntries(new URLSearchParams(options.body)) });
      return new Response(JSON.stringify({ device_code: 'fixture-device-code' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await startDeviceFlow({ clientId: auth.getGitHubClientId(), scope: auth.getGitHubScopes() });
    await exchangeDeviceCode({ clientId: auth.getGitHubClientId(), deviceCode: 'fixture-device-code' });
    expect(requests).toEqual([
      { url: 'https://github.com/login/device/code', body: { client_id: CLIENT_ID, scope: SCOPES } },
      { url: 'https://github.com/login/oauth/access_token', body: {
        client_id: CLIENT_ID, device_code: 'fixture-device-code', grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      } },
    ]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('keeps explicit custom application settings ahead of the product defaults', () => {
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ githubClientId: 'custom-app', githubScopes: 'read:user' }));
    expect(auth.getGitHubClientId()).toBe('custom-app');
    expect(auth.getGitHubScopes()).toBe('read:user');
    process.env.OPENCHAMBER_GITHUB_CLIENT_ID = 'environment-app';
    process.env.OPENCHAMBER_GITHUB_SCOPES = 'repo';
    expect(auth.getGitHubClientId()).toBe('environment-app');
    expect(auth.getGitHubScopes()).toBe('repo');
  });

  it('uses our defaults when settings omit the overrides', () => {
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ ghCliDisabled: true }));
    expect(auth.getGitHubClientId()).toBe(CLIENT_ID);
    expect(auth.getGitHubScopes()).toBe(SCOPES);
  });

  it('reconnection replaces only that account and preserves GitHub CLI settings', () => {
    const settings = JSON.stringify({ ghCliDisabled: true, ghCliActive: false });
    fs.writeFileSync(path.join(root, 'settings.json'), settings);
    const legacy = [
      { accessToken: 'fixture-old-token', accountId: 'one', user: { login: 'one' }, current: true },
      { accessToken: 'fixture-other-token', accountId: 'two', user: { login: 'two' }, current: false },
    ];
    fs.writeFileSync(path.join(root, 'github-auth.json'), JSON.stringify(legacy));
    expect(auth.getGitHubAuth().accessToken).toBe('fixture-old-token');
    auth.setGitHubAuth({ accessToken: 'fixture-new-token', scope: SCOPES, user: { login: 'one' } });
    expect(auth.getGitHubAuth().accessToken).toBe('fixture-new-token');
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'github-auth.json'), 'utf8'));
    expect(stored.map((entry) => [entry.accountId, entry.accessToken, entry.current])).toEqual([
      ['one', 'fixture-new-token', true], ['two', 'fixture-other-token', false],
    ]);
    expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).toBe(settings);
  });
});
