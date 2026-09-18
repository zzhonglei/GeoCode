/* --- GeoCode: where the embedded kernel lives (docs/DESKTOP.md §4.1). A packaged entry sits in `dist-bundle/` inside
 * the app archive, so the packaged branch reads `process.resourcesPath` instead of a path beside the module. --- */

import path from 'node:path';
import fs from 'node:fs';

export const KERNEL_DIRECTORY_NAME = 'kernel';
export const KERNEL_SIDECAR_FILENAME = 'kernel-sidecar.mjs';
export const KERNEL_BUNDLE_FILENAME = 'node.js';

export const resolveResourceRoot = ({ isDev, moduleDirectory, resourcesPath }) => {
  if (isDev) {
    if (typeof moduleDirectory !== 'string' || !moduleDirectory) {
      throw new Error('Resolving development resources requires the module directory');
    }
    return path.join(moduleDirectory, 'resources');
  }
  if (typeof resourcesPath !== 'string' || !resourcesPath) {
    throw new Error('Resolving packaged resources requires process.resourcesPath');
  }
  return resourcesPath;
};

export const resolveKernelDirectory = (options) => path.join(resolveResourceRoot(options), KERNEL_DIRECTORY_NAME);

export const resolveKernelSidecarPath = (options) => path.join(resolveKernelDirectory(options), KERNEL_SIDECAR_FILENAME);

export const assertKernelRuntimePresent = ({ sidecarPath, isDev = false, exists = fs.existsSync }) => {
  if (exists(sidecarPath)) return sidecarPath;
  throw new Error(isDev
    ? `GeoCode Kernel runtime is missing at ${sidecarPath}. Run \`bun run prepare:geocode-kernel\` in packages/electron to stage it.`
    : 'GeoCode is missing some of its files. Reinstall GeoCode.');
};
