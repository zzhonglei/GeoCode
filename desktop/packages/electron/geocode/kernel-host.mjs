/* --- GeoCode: starts and stops the kernel utility process, which main alone owns (docs/DESKTOP.md §2.1, §5.1). --- */

import { randomBytes } from 'node:crypto';
import net from 'node:net';

import { buildKernelBaseUrl } from './kernel-environment.mjs';
import {
  KERNEL_MESSAGE,
  createStartCommand,
  createStopCommand,
  parseKernelMessage,
} from './kernel-protocol.mjs';

export const KERNEL_SERVICE_NAME = 'geocode kernel';
export const KERNEL_START_STALL_TIMEOUT_MS = 60_000;
export const KERNEL_STOP_TIMEOUT_MS = 6_000;
export const KERNEL_HEALTH_INTERVAL_MS = 100;
export const KERNEL_HEALTH_REQUEST_TIMEOUT_MS = 3_000;

export const createKernelPassword = () => randomBytes(32).toString('base64url');

export const pickFreePort = async ({ hostname }) => {
  const server = net.createServer();
  try {
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: hostname, port: 0, exclusive: true }, () => {
        const address = server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error(`Could not read a port from the probe listener on ${hostname}`));
      });
    });
    return port;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

export const checkKernelHealth = async ({ baseUrl, password, fetchImpl = fetch, timeoutMs = KERNEL_HEALTH_REQUEST_TIMEOUT_MS }) => {
  const headers = new Headers();
  if (password) {
    headers.set('authorization', `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
  }
  try {
    const response = await fetchImpl(new URL('/global/health', baseUrl), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const startKernelHost = async ({
  fork,
  sidecarPath,
  cwd,
  environment,
  hostname = '127.0.0.1',
  port,
  password = createKernelPassword(),
  serviceName = KERNEL_SERVICE_NAME,
  startTimeoutMs = KERNEL_START_STALL_TIMEOUT_MS,
  stopTimeoutMs = KERNEL_STOP_TIMEOUT_MS,
  healthIntervalMs = KERNEL_HEALTH_INTERVAL_MS,
  timers = { setTimeout, clearTimeout },
  health = checkKernelHealth,
  pickPort = pickFreePort,
  logger = console,
  onStdout,
  onStderr,
}) => {
  // Resolved here, never delegated: a 0 reaching the kernel means "prefer 4096", the port a user's own opencode
  // expects (docs/DESKTOP.md §11.3).
  const requestedPort = Number.isInteger(port) && port > 0 ? port : await pickPort({ hostname });

  const child = fork(sidecarPath, [], { cwd, env: environment, serviceName, stdio: 'pipe' });

  let exited = false;
  let exitCode = null;
  const exit = defer();

  child.once('exit', (code) => {
    exited = true;
    exitCode = code ?? 0;
    exit.resolve(exitCode);
  });
  child.on('error', (error) => logger.warn?.(`[geocode-kernel] utility process error: ${error?.message ?? error}`));
  child.stdout?.on('data', (chunk) => {
    const line = chunk.toString('utf8').trimEnd();
    if (line) (onStdout ?? ((value) => logger.info?.(`[geocode-kernel] ${value}`)))(line);
  });
  child.stderr?.on('data', (chunk) => {
    const line = chunk.toString('utf8').trimEnd();
    if (line) (onStderr ?? ((value) => logger.warn?.(`[geocode-kernel] ${value}`)))(line);
  });

  const bound = await new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const cleanup = () => {
      timers.clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value) => {
      settled = true;
      cleanup();
      resolve(value);
    };
    const refresh = () => {
      timers.clearTimeout(timeout);
      timeout = timers.setTimeout(
        () => fail(new Error(`GeoCode Kernel did not report ready within ${startTimeoutMs}ms: ${sidecarPath}`)),
        startTimeoutMs,
      );
    };

    function onMessage(raw) {
      // Refresh before parsing: a message we do not recognise is still evidence of a live child.
      refresh();
      const message = parseKernelMessage(raw);
      if (!message) return;
      if (message.type === KERNEL_MESSAGE.READY) {
        succeed({ hostname: message.hostname, port: message.port });
        return;
      }
      if (message.type === KERNEL_MESSAGE.ERROR) {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }));
      }
    }
    function onExit(code) {
      fail(new Error(`GeoCode Kernel exited before reporting ready with code ${code}`));
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
    refresh();
    child.postMessage(createStartCommand({ hostname, port: requestedPort, password }));
  }).catch((error) => {
    if (!exited) child.kill();
    throw error;
  });

  const connection = {
    hostname: bound.hostname,
    port: bound.port,
    baseUrl: buildKernelBaseUrl(bound),
    password,
  };

  const wait = (async () => {
    let healthy = false;
    const gone = exit.promise.then((code) => {
      if (healthy) return;
      throw new Error(`GeoCode Kernel exited before answering a health check, with code ${code}`);
    });
    const poll = (async () => {
      while (!exited) {
        if (await health({ baseUrl: connection.baseUrl, password })) {
          healthy = true;
          return;
        }
        await new Promise((resolve) => timers.setTimeout(resolve, healthIntervalMs));
      }
    })();
    await Promise.race([poll, gone]);
  })();
  // A caller need not await this, and a kernel dying before its first answer must not leave the rejection unhandled.
  wait.catch(() => undefined);

  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    if (exited) return Promise.resolve();
    child.postMessage(createStopCommand());
    stopping = Promise.race([
      exit.promise.then(() => undefined),
      new Promise((resolve) => timers.setTimeout(resolve, stopTimeoutMs)).then(() => {
        if (exited) return;
        logger.warn?.(`[geocode-kernel] did not stop within ${stopTimeoutMs}ms, killing`);
        child.kill();
      }),
    ]);
    return stopping;
  };

  /**
   * Synchronous: main signals here and lets its own awaited shutdown settle, rather than waiting on the kernel. The
   * kernel catches the signal, so its exit handler sweeps the QGIS process groups no kill from here reaches
   * (docs/GEOKERNEL.md §10.1 #8b).
   */
  const terminate = () => {
    if (exited || stopping) return;
    child.kill();
  };

  return {
    connection,
    health: { wait },
    /** Resolves with the exit code whenever the kernel exits, whoever caused it. */
    exit: exit.promise,
    stop,
    terminate,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
  };
};
