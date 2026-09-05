/* --- GeoCode: notify-only updates from GitHub Releases (docs/DESKTOP.md §7.2).
 *
 * The app is not code-signed, so electron-updater cannot install anything on macOS; the
 * previous GeoCode announced releases and opened the release page, and this keeps that shape.
 * The backend below has the one method upstream's `checkForDesktopUpdate` helper calls, so
 * the helper, its 404-means-no-update rule and its pending-update bookkeeping stay as they
 * are. Only the source changes: the newest release of the repository DesktopIdentity names,
 * fetched anonymously.
 *
 * A 404 from the API means the repository has no release yet; it is thrown with the status
 * in the message on purpose, because that is what the helper recognises as "no update". --- */

import { DesktopIdentity } from './desktop-identity.mjs';

export const normalizeReleaseTag = (tag) => (typeof tag === 'string' ? tag.trim().replace(/^v/i, '') : '');

const numericOrString = (part) => (/^\d+$/.test(part) ? Number(part) : part);

const compareIdentifiers = (left, right) => {
  const a = numericOrString(left);
  const b = numericOrString(right);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

// Semantic version order: numeric core first, then a version without a pre-release tag is
// newer than the same core with one, then pre-release identifiers left to right.
export const compareReleaseVersions = (left, right) => {
  const [coreA, preA = ''] = normalizeReleaseTag(left).split('+')[0].split(/-(.*)/s);
  const [coreB, preB = ''] = normalizeReleaseTag(right).split('+')[0].split(/-(.*)/s);
  const a = coreA.split('.').map((value) => Number.parseInt(value || '0', 10) || 0);
  const b = coreB.split('.').map((value) => Number.parseInt(value || '0', 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let index = 0; index < Math.max(idsA.length, idsB.length); index += 1) {
    if (idsA[index] === undefined) return -1;
    if (idsB[index] === undefined) return 1;
    const diff = compareIdentifiers(idsA[index], idsB[index]);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const createReleaseUpdateBackend = ({
  currentVersion,
  fetchImpl = fetch,
  apiUrl = DesktopIdentity.releasesApiUrl,
  releasesUrl = DesktopIdentity.releasesUrl,
  timeoutMs = 10_000,
}) => ({
  checkForUpdates: async () => {
    const response = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${DesktopIdentity.productName}/${currentVersion} (+${releasesUrl})`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub release API returned ${response.status}`);
    }
    const release = await response.json();
    const version = normalizeReleaseTag(release?.tag_name);
    if (!version) {
      throw new Error('GitHub release has no version tag');
    }
    const releaseUrl = typeof release.html_url === 'string' && release.html_url
      ? release.html_url
      : `${releasesUrl}/tag/${release.tag_name}`;
    return {
      updateInfo: {
        version,
        releaseNotes: typeof release.body === 'string' && release.body.trim() ? release.body : null,
        releaseDate: typeof release.published_at === 'string' ? release.published_at : null,
        releaseUrl,
      },
    };
  },
});
