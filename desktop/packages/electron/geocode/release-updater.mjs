/* --- GeoCode: notify-only updates from the release repository DesktopIdentity names (docs/DESKTOP.md §7.2), through
 * the one method upstream's `checkForDesktopUpdate` calls. --- */

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

// Semantic version precedence, ignoring build metadata.
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
      // The status stays in the message: the helper reads a 404, a repository with no release yet, as no update.
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
