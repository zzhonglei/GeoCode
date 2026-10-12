import { describe, expect, test } from 'bun:test';

import { geeDiagnosticsOf, geeLabel, geeMessageOf } from './geeText';

const python = '/opt/anaconda3/envs/map/bin/python';

describe('GeoCode: what the Earth Engine indicator says', () => {
  // Guards against every refusal reading alike, when the reason tells the user what to fix.
  test('names a refusal by its reason, and one without a reason apart from them', () => {
    const disabled = geeLabel({ status: 'rejected', diagnostics: { message: 'x', refusal: 'api-disabled' } });
    const missing = geeLabel({ status: 'rejected', diagnostics: { message: 'x', refusal: 'project-not-found' } });
    const unknown = geeLabel({ status: 'rejected', diagnostics: { message: 'x' } });
    expect(new Set([disabled, missing, unknown]).size).toBe(3);
    expect(unknown).toBe(geeLabel({ status: 'rejected', diagnostics: { message: 'x', refusal: 'other' } }));
  });

  // Guards against showing GeoEngine's wrapped error where Google's own words say it plainly.
  test("shows what Google said on a refusal, and GeoEngine's message when Google said nothing", () => {
    const said = { status: 'rejected' as const, diagnostics: { message: 'EEException: not found', said: 'not found' } };
    expect(geeMessageOf(said)).toBe('not found');
    expect(geeMessageOf({ status: 'unreachable', diagnostics: { message: 'TransportError: refused' } })).toBe('TransportError: refused');
  });

  // Guards against the diagnostics the user copies leaving out a fact the failure came with.
  test('keeps every fact of a failure in its diagnostics', () => {
    const diagnostics = geeDiagnosticsOf({
      status: 'packages-broken',
      diagnostics: {
        message: 'installed but failing to import: geedim',
        said: 'a word from Google',
        python,
        pythonVersion: '3.10.4',
        project: 'my-project',
        missing: ['geopandas'],
        broken: [{ package: 'geedim', error: 'ImportError: dlopen failed' }],
        outdated: [{ package: 'geopandas', version: '0.14.4', required: '1.0' }],
        output: 'printed',
        traceback: 'Traceback (most recent call last)',
      },
    });
    for (const fact of [
      'packages-broken',
      'installed but failing to import: geedim',
      'a word from Google',
      python,
      '3.10.4',
      'my-project',
      'geopandas',
      'ImportError: dlopen failed',
      'geopandas 0.14.4 (needs 1.0 or later)',
      'printed',
      'Traceback (most recent call last)',
    ]) {
      expect(diagnostics).toContain(fact);
    }
  });
});
