import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildUnreadJumpList } from '../dock-menu.mjs';
import { isMadeJumpListLink, jumpListSessionLinks } from './jump-list.mjs';

// Guards against a jump list entry that only brings the window forward: its session reaches the deep-link handling,
// which lets no other openchamber:// link through.
test('GeoCode: a jump list entry opens its session, and no other link gets through', () => {
  const list = buildUnreadJumpList({ dockUnreadSessions: [{ id: 'ses_rivers1', title: 'Rivers' }] }, { execPath: 'GeoCode.exe' });
  const entry = list.find((category) => category.type === 'custom').items[0];
  const links = jumpListSessionLinks(['GeoCode.exe', entry.args]);
  assert.deepEqual(links, ['openchamber://session/ses_rivers1?source=jump-list']);
  assert.ok(links.every(isMadeJumpListLink));
  assert.deepEqual(jumpListSessionLinks(['--open-session=../../etc', '--open-session=']), []);
  assert.equal(isMadeJumpListLink('openchamber://session/ses_other?source=jump-list'), false);
});
