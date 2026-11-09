import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { GEE_FAILURES, GEE_REFUSALS, GEO_STATUS_EVENT, NO_GEO_STATUSES, pythonGateOf, pythonOverlayOf, QGIS_FAILURES } from './geoStatus';

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

/** A python status as GeoEngine reports it: the State of geoengine/src/python/index.ts, or anything else. */
const python = <Reported extends { status: string }>(value: Reported) => ({ python: { revision: 1, value } });

// Guards against the loading screen holding a window shut for good, or letting it open before the environment is ready.
test('GeoCode: a window waits for the Python environment, and opens once it is ready or there is no GeoEngine', () => {
  expect(pythonGateOf(NO_GEO_STATUSES, undefined)).toEqual({ state: 'waiting' });
  expect(pythonGateOf(NO_GEO_STATUSES, true)).toEqual({ state: 'waiting' });
  expect(pythonGateOf(python({ status: 'checking' }), true)).toEqual({ state: 'waiting' });
  expect(pythonGateOf(python({ status: 'preparing', step: 'installing', done: 162, total: 280 }), true)).toEqual({ state: 'preparing', progress: { step: 'installing', done: 162, total: 280 } });
  expect(pythonGateOf(python({ status: 'preparing', step: 'creating' }), true)).toEqual({ state: 'preparing', progress: { step: 'creating' } });
  expect(pythonGateOf(python({ status: 'preparing', step: 'warming', done: 9, total: 12 }), true)).toEqual({ state: 'preparing', progress: { step: 'warming', done: 9, total: 12 } });
  expect(pythonGateOf(python({ status: 'ready', version: '3.13.17', python: '/p', base: '/b' }), true)).toEqual({ state: 'open' });
  expect(pythonGateOf(NO_GEO_STATUSES, false)).toEqual({ state: 'open' });
  const failed = pythonGateOf(python({ status: 'failed', diagnostics: { step: 'install', message: 'pixi-unpack exited with code 1', output: 'disk full' } }), true);
  expect(failed.state === 'failed' && failed.error).toContain('disk full');
  expect(pythonGateOf(python({ status: 'unknown' }), true).state).toBe('failed');
});

// Guards against upstream's slow-start line taking the note's place as the loading screen fades out, and against the
// note outliving the preparation while the rest of the start keeps the screen up.
test('GeoCode: the loading screen keeps its note while it fades out, and only then', () => {
  const loading = { state: 'preparing', progress: { step: 'warming', done: 12, total: 12 } } as const;
  expect(pythonOverlayOf(loading, true, undefined)).toEqual({ ready: false, shown: loading });
  expect(pythonOverlayOf({ state: 'open' }, true, loading)).toEqual({ ready: true, shown: loading });
  expect(pythonOverlayOf({ state: 'open' }, false, loading)).toEqual({ ready: false, shown: undefined });
});
