import { describe, expect, it } from 'vitest';

import { createEnvironmentRuntime } from '../lib/environment/runtime.js';

// Guards against Settings handing the kernel a variable that moves its configuration, loads a binary or turns on telemetry.
describe('GeoCode: environment variables', () => {
  it('gives the kernel the user variables without the app prefixes', () => {
    const runtime = createEnvironmentRuntime({
      store: { userVariables: () => ({ GDAL_DATA: '/gdal', OPENCODE_CONFIG_DIR: '/elsewhere', BUN_INSTALL: '/bun' }) },
      listProjects: () => [],
      readOpenCodeServiceEnv: () => ({ PROJ_DATA: '/proj', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' }),
      isEnterpriseMode: () => false,
    });
    expect(runtime.forOpenCode()).toEqual({ GDAL_DATA: '/gdal', PROJ_DATA: '/proj' });
  });
});
