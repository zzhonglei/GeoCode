import { describe, expect, test } from 'bun:test';

import { configuredOf, isProjectId, stepsOf } from './geeSteps';

const python = '/opt/anaconda3/envs/map/bin/python';
const at = { python, project: 'p', message: 'm' };

describe('GeoCode: the steps of setting Earth Engine up', () => {
  // Guards against marking a step done that the check never reached, or the wrong step as the one to fix.
  test('marks the step a failure belongs to, and leaves the steps after it unknown', () => {
    expect(stepsOf({ status: 'packages-missing', diagnostics: { ...at, missing: ['geedim'] } })).toEqual({
      python: 'problem',
      account: 'unknown',
      project: 'todo',
    });
    expect(stepsOf({ status: 'signed-out', diagnostics: at })).toEqual({ python: 'done', account: 'signed-out', project: 'todo' });
    expect(stepsOf({ status: 'rejected', diagnostics: { ...at, refusal: 'credentials-invalid' } })).toEqual({
      python: 'done',
      account: 'expired',
      project: 'todo',
    });
    expect(stepsOf({ status: 'rejected', diagnostics: { ...at, refusal: 'api-disabled' } })).toEqual({
      python: 'done',
      account: 'signed-in',
      project: 'problem',
    });
    expect(stepsOf({ status: 'project-missing', diagnostics: at })).toEqual({ python: 'done', account: 'signed-in', project: 'todo' });
  });

  // Guards against a check cut off while importing the packages showing every step done.
  test('claims no step for a check that timed out or ended without a report', () => {
    const unknown = { python: 'todo', account: 'unknown', project: 'todo' };
    expect(stepsOf({ status: 'check-timeout', diagnostics: at })).toEqual(unknown);
    expect(stepsOf({ status: 'check-failed', diagnostics: at })).toEqual(unknown);
  });

  test('blames no step for the network, and has nothing done before a Python is chosen', () => {
    const done = { python: 'done', account: 'signed-in', project: 'done' };
    expect(stepsOf({ status: 'unreachable', diagnostics: at })).toEqual(done);
    expect(stepsOf({ status: 'ready', python, project: 'p', versions: {} })).toEqual(done);
    expect(stepsOf({ status: 'unconfigured', project: 'p' })).toEqual({ python: 'todo', account: 'no-python', project: 'todo' });
    expect(stepsOf(undefined)).toEqual({ python: 'todo', account: 'no-python', project: 'todo' });
  });

  // Guards against the settings losing a project named before the Python, whose status has nothing else to show it by.
  test('finds what the configuration names in any status', () => {
    expect(configuredOf({ status: 'unconfigured', project: 'p' })).toEqual({ project: 'p' });
    expect(configuredOf({ status: 'checking', python, project: 'p' })).toEqual({ python, project: 'p' });
    expect(configuredOf({ status: 'signed-out', diagnostics: at })).toEqual({ python, project: 'p' });
    expect(configuredOf({ status: 'config-error', diagnostics: { message: 'm' } })).toEqual({});
  });
});

// Guards against saving a project ID the request to Earth Engine cannot carry, as one typed with a full-width comma.
test('GeoCode: a project ID is saved only as Earth Engine can be asked about it', () => {
  expect(['majestic-layout-486003-v4', 'example.com:my-project'].map(isProjectId)).toEqual([true, true]);
  expect(['majestic-layout-486003-v4、5', 'has space', '', '-leading'].map(isProjectId)).toEqual([false, false, false, false]);
});
