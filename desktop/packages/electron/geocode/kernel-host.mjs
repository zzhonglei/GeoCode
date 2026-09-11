/* --- GeoCode: Electron main as the sole owner of the Agent Kernel process
 * (docs/DESKTOP.md §2.1, §5.1, §5.2).
 *
 * The shell runtime gives up this ownership through its own skip-start path, so nothing
 * downstream restarts or discovers a kernel behind our back. That makes this module the
 * one place where a kernel is born and the one place where it dies.
 *
 * Three timing rules, all taken from the upstream desktop's equivalent host because they
 * were paid for there:
 *
 *   - the start deadline is a STALL timer, refreshed by every message. A kernel that is
 *     slowly reporting progress is alive; one that has said nothing for the whole window
 *     is not, and the difference matters on a cold first launch;
 *   - stop asks before it kills, and every kill here is a signal the kernel catches: its exit
 *     handler owes its children a synchronous sweep (GEOKERNEL.md §10.1 #8b), and a kill it
 *     cannot catch orphans whatever QGIS process was mid-run;
 *   - an exit before ready fails the start rather than hanging until the deadline.
 *
 * Readiness is the kernel's own report. `health.wait` confirms it over HTTP for a caller that
 * needs the router answering, not just `listen` returning; starting does not wait for it. --- */

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

/** One per launch, never persisted: the kernel outlives no session, so neither should its credential. */
export const createKernelPassword = () => randomBytes(32).toString('base64url');

/**
 * Chooses the port before the kernel does, and never hands it a 0.
 *
 * `Server.listen` reads an explicit 0 as "prefer 4096, then anything free" — deliberate
 * upstream behaviour, and exactly the wrong one here: 4096 is the port a user's own
 * opencode expects, and taking it would break their install rather than ours
 * (docs/DESKTOP.md §11.3). Asking the OS for a port up front costs one bind and keeps the
 * embedded kernel out of that address entirely.
 */
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
  // Resolved here rather than delegated: a 0 reaching the kernel means "prefer 4096".
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
   * The synchronous counterpart to `stop`, for the shutdown path Electron gives us.
   * `shutdownBackgroundServices` is followed immediately by `app.exit(0)` in the same tick,
   * so an awaited stop would never be reached. The signal is what lets the kernel's exit
   * handler sweep its QGIS children, which sit in process groups of their own where no kill
   * from here reaches them (GEOKERNEL.md §10.1 #8b).
   */
  const terminate = () => {
    if (exited || stopping) return;
    child.kill();
  };

  return {
    connection,
    health: { wait },
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
