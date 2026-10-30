import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { CLOSED_COMMANDS } from './closed-commands.mjs';

// Guards against upstream renaming a closed command, which reopens it under its new name with nothing failing.
test('GeoCode: every closed command is one the app still handles', () => {
  const main = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...CLOSED_COMMANDS].filter((command) => !main.includes(`case '${command}':`)), []);
});
