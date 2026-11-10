import { expect, test } from 'bun:test';

import { OPENCHAMBER_ACTIONS } from '@/components/sections/agents/agentPermissionModel';

import { GEO_TOOL_ACTIONS } from './geoTools';
import { GEO_PERMISSION_KEYS, permissionRowName } from './toolPermissions';

// Guards against a geo tool the settings cannot set, which would ask, or not, with no row to change it.
test('GeoCode: each geo tool with a rule of its own has exactly one row in the tool permissions', () => {
  const rows = (tool: string) =>
    GEO_PERMISSION_KEYS.filter((key) => (key.endsWith('*') ? tool.startsWith(key.slice(0, -1)) : key === tool));
  for (const tool of GEO_TOOL_ACTIONS) expect([tool, rows(tool).length]).toEqual([tool, 1]);
});

// Guards against a merge adding upstream's new agent tool to the rows: an agent never gets a closed tool (the secret
// tool), so its row would set nothing and show upstream's name.
test('GeoCode: the shell\'s agent tools in the tool permissions are GeoCode\'s, each named as GeoCode', () => {
  for (const key of OPENCHAMBER_ACTIONS) expect([key, permissionRowName(key)?.startsWith('GeoCode')]).toEqual([key, true]);
});
