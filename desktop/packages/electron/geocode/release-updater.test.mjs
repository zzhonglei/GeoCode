/* --- GeoCode: the update check reads GitHub Releases and never configures electron-updater
 * (docs/DESKTOP.md §7.2).
 *
 * The backend is driven through upstream's own `checkForDesktopUpdate` helper, because that
 * is how main.mjs calls it: what is pinned is the pair, not the backend alone. The main.mjs
 * wiring is pinned by reading its source, the same way kernel-environment.test.mjs pins the
 * order of its imports. --- */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkForDesktopUpdate } from '../updater-check.mjs';
import { DesktopIdentity } from './desktop-identity.mjs';
import { compareReleaseVersions, createReleaseUpdateBackend, normalizeReleaseTag } from './release-updater.mjs';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = fs.readFileSync(path.join(electronRoot, 'main.mjs'), 'utf8');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/zzhonglei/GeoCode-Release/releases/tag/${tag}`,
  body: `Notes for ${tag}`,
  published_at: '2026-09-01T00:00:00Z',
  ...extra,
});

const check = async (fetchImpl, currentVersion = '1.0.0') => {
  const requests = [];
  const backend = createReleaseUpdateBackend({
    currentVersion,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return fetchImpl(url, init);
    },
  });
  const result = await checkForDesktopUpdate({
    autoUpdater: backend,
    currentVersion,
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
  });
  return { result, requests };
};

describe('release update check', () => {
  it('asks the identity-derived releases endpoint anonymously, naming the product', async () => {
    const { requests } = await check(async () => jsonResponse(200, release('v1.0.0')));
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(DesktopIdentity.releasesApiUrl);
    expect(requests[0].init.headers['User-Agent']).toMatch(/^GeoCode\/1\.0\.0 /);
    expect(requests[0].init.headers.Authorization).toBeUndefined();
  });

  it('reports a newer release with its notes and page', async () => {
    const { result } = await check(async () => jsonResponse(200, release('v1.2.0')));
    expect(result.available).toBe(true);
    expect(result.nextVersion).toBe('1.2.0');
    expect(result.pendingUpdate?.version).toBe('1.2.0');
    expect(result.updateInfo).toEqual({
      version: '1.2.0',
      releaseNotes: 'Notes for v1.2.0',
      releaseDate: '2026-09-01T00:00:00Z',
      releaseUrl: 'https://github.com/zzhonglei/GeoCode-Release/releases/tag/v1.2.0',
    });
  });

  it('treats the current or an older release as no update', async () => {
    expect((await check(async () => jsonResponse(200, release('v1.0.0')))).result.available).toBe(false);
    expect((await check(async () => jsonResponse(200, release('v0.9.9')))).result.available).toBe(false);
  });

  it('treats a repository without releases (404) as no update rather than an error', async () => {
    const { result } = await check(async () => jsonResponse(404, { message: 'Not Found' }));
    expect(result.available).toBe(false);
    expect(result.pendingUpdate).toBeNull();
  });

  it('surfaces other failures as a check failure', async () => {
    await expect(check(async () => jsonResponse(500, null))).rejects.toThrow(/Unable to check for updates/);
  });
});

describe('release version order', () => {
  it('strips the tag prefix and orders pre-releases below their final version', () => {
    expect(normalizeReleaseTag('v1.2.3')).toBe('1.2.3');
    expect(compareReleaseVersions('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareReleaseVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareReleaseVersions('1.2.3-beta.2', '1.2.3-beta.1')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.2.3-rc.1', '1.2.3-beta.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.2.4-beta.1', '1.2.3')).toBeGreaterThan(0);
  });
});

describe('main.mjs wiring', () => {
  it('never configures an electron-updater feed', () => {
    expect(mainSource).toMatch(/const setupAutoUpdater = \(\) => \{\n\s*\/\/ --- GeoCode:[\s\S]*?\n\s*return;\n/);
  });

  it('answers the update check from the release backend and refuses in-app downloads', () => {
    expect(mainSource).toContain('autoUpdater: releaseUpdateBackend,');
    expect(mainSource).toContain('compareVersions: compareReleaseVersions,');
    expect(mainSource).toMatch(/case 'desktop_download_and_install_update':\n\s*\/\/ --- GeoCode:[\s\S]*?\n\s*throw new Error\('GeoCode updates are downloaded from the release page'\);/);
  });
});
