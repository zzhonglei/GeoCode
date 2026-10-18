import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTrayMenuTemplate } from '../tray-menu.mjs';

const approval = (id, reviewInApp) => ({
  kind: 'permission', id, sessionId: 'session', directory: '/project', label: 'Run QGIS Algorithm', reviewInApp, canSave: true,
});

const repliesFrom = (approvals) => {
  const actions = [];
  const visit = (items) => {
    for (const item of items) {
      item.click?.();
      if (item.submenu) visit(item.submenu);
    }
  };
  visit(buildTrayMenuTemplate({ approvals }, { statusIcons: {}, onAction: (action) => actions.push(action) }));
  return actions.filter((action) => action.type === 'respond-permission').map((action) => action.response);
};

// Guards against a run being allowed, once or always, from the tray, which would skip its card.
test('a run can only be denied from the tray, in the menu and in its overflow', () => {
  assert.deepEqual(repliesFrom(Array.from({ length: 12 }, (_, index) => approval(String(index), true))), Array(12).fill('reject'));
  assert.deepEqual(repliesFrom([approval('other', false)]), ['once', 'always', 'reject']);
});
