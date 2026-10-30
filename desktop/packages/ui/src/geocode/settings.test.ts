import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { CLOSED_SEARCH_ITEMS } from './settings';

// Guards against upstream renaming a closed setting, which shows it again in search with nothing failing.
test('GeoCode: every closed search item is one settings search still lists', () => {
  const source = fs.readFileSync(new URL('../lib/settings/search.ts', import.meta.url), 'utf8');
  const ids = new Set([...source.matchAll(/^\s+id: '([^']+)',$/gm)].map((match) => match[1]));
  expect([...CLOSED_SEARCH_ITEMS].filter((id) => !ids.has(id))).toEqual([]);
});
