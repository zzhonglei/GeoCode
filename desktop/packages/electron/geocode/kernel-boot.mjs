/* --- GeoCode: the single call main.mjs makes to bring the Agent Kernel up
 * (docs/DESKTOP.md §5.1).
 *
 * Locating the runtime, building its environment, starting it and pointing the shell at it
 * are four steps that always happen together and never apart, so they are composed here
 * rather than at the call site. What main.mjs gains from this is not brevity: it is that
 * the wiring stays one appended line in an upstream file we do not otherwise touch.
 *
 * Ordering is the part that matters. The shell runtime reads its OpenCode connection at
 * import time (`hmr-state-runtime.js` takes `OPENCODE_SERVER_PASSWORD` as an initial
 * value), so the environment must carry a live kernel BEFORE `@openchamber/web` is
 * imported — which is why this returns rather than starting the shell itself, and why the
 * caller must await it first. --- */

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
    ...(exists ? { exists } : {}),
  });

  // The kernel's last lines travel with a start failure, so the failure screen can show them.
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
  return handle;
};
