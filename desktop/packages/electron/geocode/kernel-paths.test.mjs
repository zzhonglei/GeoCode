import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import {
  KERNEL_SIDECAR_FILENAME,
  assertKernelRuntimePresent,
  resolveKernelDirectory,
  resolveKernelSidecarPath,
  resolveResourceRoot,
} from './kernel-paths.mjs';

describe('resolveResourceRoot', () => {
  it('sits beside the entry point in development', () => {
    expect(resolveResourceRoot({ isDev: true, moduleDirectory: '/repo/packages/electron' }))
      .toBe(path.join('/repo/packages/electron', 'resources'));
  });

  it('reads process.resourcesPath once packaged, ignoring the module location', () => {
    expect(resolveResourceRoot({
      isDev: false,
      moduleDirectory: '/Applications/GeoCode.app/Contents/Resources/app.asar/dist-bundle',
      resourcesPath: '/Applications/GeoCode.app/Contents/Resources',
    })).toBe('/Applications/GeoCode.app/Contents/Resources');
  });

  it('refuses to guess when its anchor is missing', () => {
    expect(() => resolveResourceRoot({ isDev: true })).toThrow(/module directory/);
    expect(() => resolveResourceRoot({ isDev: false })).toThrow(/resourcesPath/);
  });
});

describe('resolveKernelSidecarPath', () => {
  it('names the sidecar inside the kernel directory in both shapes', () => {
    expect(resolveKernelSidecarPath({ isDev: true, moduleDirectory: '/repo/packages/electron' }))
      .toBe(path.join('/repo/packages/electron', 'resources', 'kernel', KERNEL_SIDECAR_FILENAME));
    expect(resolveKernelSidecarPath({ isDev: false, resourcesPath: '/app/Resources' }))
      .toBe(path.join('/app/Resources', 'kernel', KERNEL_SIDECAR_FILENAME));
  });

  it('puts the sidecar inside the directory it reports', () => {
    const options = { isDev: false, resourcesPath: '/app/Resources' };
    expect(path.dirname(resolveKernelSidecarPath(options))).toBe(resolveKernelDirectory(options));
  });
});

describe('assertKernelRuntimePresent', () => {
  it('returns the path when the runtime is staged', () => {
    expect(assertKernelRuntimePresent({ sidecarPath: '/app/kernel/kernel-sidecar.mjs', exists: () => true }))
      .toBe('/app/kernel/kernel-sidecar.mjs');
  });

  it('names both the missing path and the command that stages it', () => {
    expect(() => assertKernelRuntimePresent({ sidecarPath: '/app/kernel/kernel-sidecar.mjs', exists: () => false }))
      .toThrow(/\/app\/kernel\/kernel-sidecar\.mjs/);
    expect(() => assertKernelRuntimePresent({ sidecarPath: '/app/kernel/kernel-sidecar.mjs', exists: () => false }))
      .toThrow(/prepare:geocode-kernel/);
  });
});
