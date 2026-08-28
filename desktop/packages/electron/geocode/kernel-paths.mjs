/* --- GeoCode: where the embedded Agent Kernel lives, in both shapes the app runs in
 * (docs/DESKTOP.md §4.1).
 *
 * The two shapes resolve from different anchors, and that is upstream's convention rather
 * than ours: `main.mjs` computes its own `resourceRoot()` the same way. In development the
 * entry point is `main.mjs` at the package root, so `resources/` sits beside it; once
 * packaged the entry moves into `dist-bundle/` and the resources are no longer relative to
 * it at all, which is why the packaged branch reads `process.resourcesPath` instead of
 * deriving a path from the module's own location.
 *
 * Keeping this in a module of its own — rather than reusing upstream's `resourceRoot()` —
 * is what lets both branches be tested without an Electron app object. --- */

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

/**
 * Fails with the command that fixes it. A missing kernel is not a user error and not a
 * runtime fault: it means the build step that stages it never ran, and saying so here
 * saves reading a module-resolution stack from inside a utility process that died at import.
 */
export const assertKernelRuntimePresent = ({ sidecarPath, exists = fs.existsSync }) => {
  if (exists(sidecarPath)) return sidecarPath;
  throw new Error(
    `GeoCode Kernel runtime is missing at ${sidecarPath}. Run \`bun run prepare:geocode-kernel\` in packages/electron to stage it.`,
  );
};
