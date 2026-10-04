import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';

import { GEO_STATUS_EVENT, NO_GEO_STATUSES, QGIS_FAILURES, withGeoStatusEvent, withGeoStatusSnapshot } from './geoStatus';

const checking = { status: 'checking', path: '/Applications/QGIS.app' };
const ready = { status: 'ready' };

// Guards against the indicator going back to an older status when a snapshot read before a change arrives after it.
describe('GeoCode: GeoEngine statuses in the interface', () => {
  test('keeps a change that is newer than a snapshot arriving after it', () => {
    const changed = withGeoStatusEvent(NO_GEO_STATUSES, { type: 'geo-status', revision: 3, domain: 'qgis', value: ready });
    const stale = withGeoStatusSnapshot(changed, { revision: 2, statuses: { qgis: checking, gee: checking } });
    expect(stale.qgis.value).toEqual(ready);
    expect(stale.gee.value).toEqual(checking);
  });

  test('takes a snapshot as new as the change it holds, and ignores a change it already has', () => {
    const changed = withGeoStatusEvent(NO_GEO_STATUSES, { type: 'geo-status', revision: 3, domain: 'qgis', value: checking });
    const current = withGeoStatusSnapshot(changed, { revision: 3, statuses: { qgis: ready } });
    expect(current.qgis.value).toEqual(ready);
    expect(withGeoStatusEvent(current, { type: 'geo-status', revision: 3, domain: 'qgis', value: checking })).toBe(current);
  });
});

// Guards against the server and the interface naming the change differently, which leaves the indicator on a stale status.
test('GeoCode: the interface listens for the change the server sends', () => {
  const source = fs.readFileSync(new URL('../../../web/server/geocode/geoengine.js', import.meta.url), 'utf8');
  expect(source).toContain(`export const GEO_STATUS_EVENT = '${GEO_STATUS_EVENT}';`);
});

// Guards against a QGIS failure GeoEngine reports that the interface cannot read, which it would show as unrecognized.
test('GeoCode: the interface knows every QGIS failure GeoEngine reports', () => {
  const source = fs.readFileSync(new URL('../../../../../geoengine/src/qgis/index.ts', import.meta.url), 'utf8');
  const union = source.match(/export type Failed =([\s\S]*?)\n\n/)?.[1] ?? '';
  const failures = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  expect(failures.length).toBeGreaterThan(0);
  expect([...QGIS_FAILURES].sort()).toEqual(failures.sort());
});
