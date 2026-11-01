import { describe, expect, test } from 'bun:test';

import { trackerTargetOfUrl } from '@/components/sourceBoard/openTrackerItem';

// Guards against GitLab links opening in the Tracker or on the board, which read them through the closed GitLab routes;
// a link that names no target opens in the browser.
describe('GeoCode: links to GitLab', () => {
  test('name no Tracker target, while links to GitHub still do', () => {
    expect(trackerTargetOfUrl('https://gitlab.com/group/project/-/merge_requests/7')).toBeNull();
    expect(trackerTargetOfUrl('https://gitlab.com/group/project/-/issues/7')).toBeNull();
    expect(trackerTargetOfUrl('https://github.com/owner/repo/pull/7')).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerTargetOfUrl('https://github.com/owner/repo/issues/7')).toEqual({ source: 'repository', kind: 'issue' });
  });
});
