import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoPermissionLabel } from './geo-permissions.js';

const geocode = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ui', 'src', 'geocode');
const source = (file) => fs.readFileSync(path.join(geocode, file), 'utf8');

/** The quoted names in the list a pattern finds. */
const names = (text, pattern) => [...text.match(pattern)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

describe('GeoCode: geo permission notifications', () => {
  // Guards against the copy drifting from the interface's, whose titles the tray and the in-app toast show.
  it("name every geo tool's request as the tray does", () => {
    const tools = source('geoTools.ts');
    const titles = tools + source('osmText.ts');
    const actions = names(tools, /GEO_TOOL_ACTIONS = \[([^\]]*)\]/);
    const inApp = new Set(names(tools, /const IN_APP\b[^=]*= new Set\(\[([^\]]*)\]\)/));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(titles, action).toContain(`'${geoPermissionLabel(action, [])}'`);
      // A run or a download names neither the algorithm nor the folder; the others name what they are about.
      expect(geoPermissionLabel(action, ['about']).endsWith(': about'), action).toBe(!inApp.has(action));
    }
  });
});
