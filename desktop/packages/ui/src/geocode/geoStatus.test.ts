import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';

import {
  GEE_FAILURES,
  GEE_REFUSALS,
  GEO_STATUS_EVENT,
  NO_GEO_STATUSES,
  QGIS_FAILURES,
  geeStatusOf,
  withGeoStatusEvent,
  withGeoStatusSnapshot,
} from './geoStatus';

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

/** The literals of a type union declared in GeoEngine's source, as `export type <name> =`. */
const unionIn = (file: string, name: string) => {
  const source = fs.readFileSync(new URL(`../../../../../geoengine/src/${file}`, import.meta.url), 'utf8');
  const union = source.match(new RegExp(`export type ${name} =([\\s\\S]*?)\\n\\n`))?.[1] ?? '';
  return [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort();
};

// Guards against an Earth Engine failure or refusal GeoEngine reports that the interface cannot read.
test('GeoCode: the interface knows every Earth Engine failure and refusal GeoEngine reports', () => {
  const failures = unionIn('gee/index.ts', 'Failed');
  const refusals = unionIn('gee/index.ts', 'Refusal');
  expect(failures.length).toBeGreaterThan(0);
  expect(refusals.length).toBeGreaterThan(0);
  expect([...GEE_FAILURES].sort()).toEqual(failures);
  expect([...GEE_REFUSALS].sort()).toEqual(refusals);
});

// Guards against the interface's copy of Earth Engine's state drifting from GeoEngine's, which would show a real state
// as unknown: one of each shape GeoEngine produces, as it reaches the interface, through JSON.
test('GeoCode: the interface reads every shape of Earth Engine state GeoEngine produces', () => {
  const python = '/opt/anaconda3/envs/map/bin/python';
  const states = [
    { status: 'unconfigured' },
    { status: 'unconfigured', project: 'p' },
    { status: 'checking', python },
    { status: 'checking', python, project: 'p' },
    { status: 'ready', python, project: 'p', versions: { python: '3.11.15', 'earthengine-api': '1.7.19', requests: '' } },
    { status: 'config-error', diagnostics: { message: 'Unexpected token at line 1, column 2', file: '/machine.json' } },
    { status: 'python-missing', diagnostics: { python, message: 'spawn ENOENT' } },
    { status: 'packages-missing', diagnostics: { python, project: 'p', message: 'not installed: geedim', missing: ['geedim'] } },
    {
      status: 'packages-broken',
      diagnostics: { python, message: 'installed but failing to import: geedim', broken: [{ package: 'geedim', error: 'ImportError: x' }], missing: [] },
    },
    {
      status: 'packages-outdated',
      diagnostics: {
        python,
        pythonVersion: '3.11.9',
        project: 'p',
        message: 'older than GeoCode needs: geedim 1.9.1 (2.0 or later)',
        outdated: [{ package: 'geedim', version: '1.9.1', required: '2.0' }],
      },
    },
    { status: 'signed-out', diagnostics: { python, message: 'no Earth Engine credentials on this computer' } },
    { status: 'project-missing', diagnostics: { python, message: 'no Google Cloud project is configured' } },
    { status: 'unreachable', diagnostics: { python, project: 'p', message: 'TransportError: x', said: 'unavailable', traceback: 'Traceback' } },
    {
      status: 'rejected',
      diagnostics: { python, project: 'p', message: 'EEException: x', refusal: 'no-permission', said: 'Caller does not have permission', traceback: 'Traceback' },
    },
    { status: 'check-timeout', diagnostics: { python, project: 'p', message: 'the check did not finish within 90 seconds', output: '' } },
    { status: 'check-failed', diagnostics: { python, message: 'the Python exited with code 9 without a report', output: 'Python was not found' } },
  ];
  for (const state of states) {
    const statuses = withGeoStatusEvent(NO_GEO_STATUSES, {
      type: 'geo-status',
      revision: 1,
      domain: 'gee',
      value: JSON.parse(JSON.stringify(state)),
    });
    expect(geeStatusOf(statuses)?.status).toBe(state.status);
  }
});
