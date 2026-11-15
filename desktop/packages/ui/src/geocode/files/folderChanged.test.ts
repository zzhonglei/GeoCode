import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { FOLDER_CHANGED_EVENT } from './folderChanged';

// Guards against a window that no longer hears the server's folder changes after one side renames the event.
test('the window listens for the event the server sends', () => {
  const source = fs.readFileSync(new URL('../../../../web/server/geocode/folder-watch.js', import.meta.url), 'utf8');
  expect(source).toContain(`export const FOLDER_CHANGED_EVENT = '${FOLDER_CHANGED_EVENT}';`);
});
