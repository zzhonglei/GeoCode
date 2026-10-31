import { expect, test } from 'bun:test';

import { GEO_TOOL_ACTIONS } from './geoTools';
import { GEO_PERMISSION_KEYS } from './toolPermissions';

// Guards against a geo tool the settings cannot set, which would ask, or not, with no row to change it.
test('GeoCode: each geo tool with a rule of its own has exactly one row in the tool permissions', () => {
  const rows = (tool: string) =>
    GEO_PERMISSION_KEYS.filter((key) => (key.endsWith('*') ? tool.startsWith(key.slice(0, -1)) : key === tool));
  for (const tool of GEO_TOOL_ACTIONS) expect([tool, rows(tool).length]).toEqual([tool, 1]);
});
