/* --- GeoCode: brings the kernel up for main.mjs (docs/DESKTOP.md §5.1). Await it before importing `@openchamber/web`,
 * which reads the kernel connection from the environment at import. --- */

import { applyKernelConnectionToShellEnvironment, createKernelProcessEnvironment } from './kernel-environment.mjs';
import { startKernelHost } from './kernel-host.mjs';
import { assertKernelRuntimePresent, resolveKernelSidecarPath } from './kernel-paths.mjs';
import { createOutputTail } from './kernel-failure.mjs';

export const startEmbeddedKernel = async ({
  isDev,
  moduleDirectory,
  resourcesPath,
  fork,
  cwd,
  environment,
  overrides = {},
  logger = console,
  startKernel = startKernelHost,
  exists,
}) => {
  const sidecarPath = assertKernelRuntimePresent({
    sidecarPath: resolveKernelSidecarPath({ isDev, moduleDirectory, resourcesPath }),
    isDev,
    ...(exists ? { exists } : {}),
  });

  // The kernel's last lines travel with a failure, at start or later, so the failure screen can show them.
  const tail = createOutputTail();
  let handle;
  try {
    handle = await startKernel({
      fork,
      sidecarPath,
      cwd,
      environment: createKernelProcessEnvironment({ environment, overrides }),
      logger,
      onStdout: (line) => { tail.push(line); logger.info?.(`[geocode-kernel] ${line}`); },
      onStderr: (line) => { tail.push(line); logger.warn?.(`[geocode-kernel] ${line}`); },
    });
  } catch (error) {
    if (error && typeof error === 'object') error.kernelOutput = tail.lines();
    throw error;
  }

  applyKernelConnectionToShellEnvironment({ environment, connection: handle.connection });
  logger.info?.(`[geocode-kernel] ready at ${handle.connection.baseUrl}`);
  return Object.assign(handle, { outputTail: tail.lines });
};
