import { describe, expect, test } from 'bun:test';

import { startupCause } from './kernelStart';

// Guards against the failure page offering a retry, or blaming the wrong part, for a kernel that is not installed.
describe('GeoCode: startup failure cause', () => {
  test('calls a kernel the local service never found an incomplete installation', () => {
    expect(startupCause('openCodeUnavailable', { error: 'missing', binary: null })).toBe('install');
  });

  test('calls a kernel that was started and failed a kernel failure', () => {
    expect(startupCause('openCodeUnavailable', { error: 'exited', binary: '/app/kernel' })).toBe('kernel');
    expect(startupCause(undefined, null)).toBe('kernel');
  });

  test('blames the settings only when the local service reports a running kernel', () => {
    expect(startupCause('loadAgents', null)).toBe('settings');
    expect(startupCause('loadAgents', { error: 'exited', binary: '/app/kernel' })).toBe('kernel');
  });

  test('blames the local service when it cannot be reached', () => {
    expect(startupCause('serverUnreachable', null)).toBe('service');
  });
});
