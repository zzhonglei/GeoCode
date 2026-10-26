import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { describeSavePatterns } from '@/components/chat/permissionSummary';
import type { Metadata, Part } from '@/lib/opencode/model';
import type { PermissionRequest } from '@/types/permission';

import { geoCardText, reviewInApp } from './geoTools';
import { OsmPermissionBody } from './OsmPermission';
import { osmArea, osmNames } from './osmView';

const HOME = '/Users/me';

const asking = (action: string, metadata: Metadata): PermissionRequest => ({
  id: `per_${action}`,
  sessionID: 'ses_1',
  action,
  resources: ['*'],
  metadata,
});

const card = (permission: PermissionRequest, names: Readonly<Record<string, string>> = {}) =>
  renderToStaticMarkup(<OsmPermissionBody permission={permission} names={names} locale="en" home={HOME} />);

const searched = (status: 'running' | 'completed', candidates: Metadata[]): Part => ({
  id: `call_${status}`,
  sessionID: 'ses_1',
  messageID: 'msg_a',
  type: 'tool',
  callID: `call_${status}`,
  tool: 'osmsearch',
  state:
    status === 'running'
      ? { status, input: {}, metadata: { found: { candidates } }, time: { start: 1 } }
      : { status, input: {}, output: '', metadata: { found: { candidates } }, time: { start: 1, end: 2 } },
});

describe("GeoCode: the OSM tools' permission cards", () => {
  test('a download warns of a directory outside the project it writes in, and of none inside it', () => {
    const outside = `${HOME}/Desktop/osm`;
    const download = (output: string, external: string[]) =>
      card(asking('osmgetfeatures', { area: 'R1', tags: ['amenity'], output, description: 'POIs', external }));
    const warning = geoCardText('en').outside('~/Desktop/osm');
    expect(download(`${outside}/poi.gpkg`, [outside])).toContain(warning);
    expect(download(`${HOME}/thesis/poi.gpkg`, [])).not.toContain(warning);
  });

  test('an id is shown with the name the session found for it, in either case, and alone when none was', () => {
    // Guards against an id the tools take in lower case going without the name the user knows it by.
    const html = card(
      asking('osmgetobjects', { ids: ['r10958940', 'W208549334'], output: `${HOME}/a.gpkg`, external: [] }),
      { R10958940: '國立臺北大學' },
    );
    expect(html).toContain('國立臺北大學');
    expect(html).toContain('W208549334');
  });

  test('an area is taken apart as the tools read it, and one written otherwise stays as written', () => {
    expect(osmArea('r1, W2')).toEqual({ kind: 'objects', places: ['R1', 'W2'] });
    expect(osmArea('around:R1,W2,200')).toEqual({ kind: 'around', places: ['R1', 'W2'], meters: '200' });
    expect(osmArea('around:24.9431,121.3684,300')).toEqual({
      kind: 'around',
      places: ['24.9431, 121.3684'],
      meters: '300',
    });
    expect(osmArea('bbox:24.93,121.36,24.95,121.38')).toEqual({
      kind: 'box',
      from: '24.93, 121.36',
      to: '24.95, 121.38',
    });
    const file = (path: string, layer?: string) => ({ kind: 'file', path, layer });
    expect(osmArea('file:/data/a.gpkg|layername=campus')).toEqual(file('/data/a.gpkg', 'campus'));
    expect(osmArea('file:/data/a.geojson')).toEqual(file('/data/a.geojson'));
    expect(osmArea('bbox:1,2,3')).toEqual({ kind: 'text', text: 'bbox:1,2,3' });
  });

  test("names come from the session's finished searches alone", () => {
    const names = osmNames([
      searched('completed', [{ id: 'R1', name: '國立臺北大學' }, { id: 'W2', name: null, name_en: 'Campus' }]),
      searched('running', [{ id: 'R3', name: 'Not yet' }]),
    ]);
    expect(names).toEqual({ R1: '國立臺北大學', W2: 'Campus' });
  });

  test('a download is approved on its card alone, and "always allow" remembers the directory it names', () => {
    // Guards against a download approved where what it writes, and where, cannot be seen.
    expect([reviewInApp('osmgetobjects'), reviewInApp('osmgetfeatures'), reviewInApp('osmsearch')]).toEqual([
      true,
      true,
      false,
    ]);
    for (const download of ['osmgetobjects', 'osmgetfeatures']) {
      expect(describeSavePatterns(download, [`${HOME}/Desktop/osm/*`])).toEqual([`${HOME}/Desktop/osm`]);
      expect(describeSavePatterns(download, ['*'])).toEqual([]);
    }
  });
});
