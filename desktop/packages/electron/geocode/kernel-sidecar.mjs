/* --- GeoCode: the process entry for the kernel bundle, which exports `Server` and has no main (docs/DESKTOP.md §2.1).
 * Staged beside the bundle by scripts/prepare-geocode-kernel.mjs, where its relative imports resolve. --- */

import http from 'node:http';
import tls from 'node:tls';

import {
  KERNEL_COMMAND,
  createErrorMessage,
  createReadyMessage,
  createStoppedMessage,
  parseKernelCommand,
} from './kernel-protocol.mjs';

const KERNEL_BUNDLE = './node.js';
const SERVER_USERNAME = 'opencode';

/** `process.parentPort` under Electron; started directly from a shell, line-delimited JSON on stdio stands in. */
const resolveParentPort = () => {
  if (process.parentPort) return process.parentPort;

  return {
    postMessage: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    on: (event, listener) => {
      if (event !== 'message') return;
      process.stdin.setEncoding('utf8');
      let buffered = '';
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
        let index = buffered.indexOf('\n');
        while (index >= 0) {
          const line = buffered.slice(0, index).trim();
          buffered = buffered.slice(index + 1);
          if (line) {
            try {
              listener({ data: JSON.parse(line) });
            } catch {
              // Not a command; a stray line must not take the kernel down.
            }
          }
          index = buffered.indexOf('\n');
        }
      });
    },
  };
};

// The kernel's server reads its credential only from the environment.
const applyCredential = (password) => {
  process.env.OPENCODE_SERVER_USERNAME = SERVER_USERNAME;
  if (password) {
    process.env.OPENCODE_SERVER_PASSWORD = password;
    return;
  }
  delete process.env.OPENCODE_SERVER_PASSWORD;
};

const ensureLoopbackBypassesProxy = () => {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const items = (process.env[key] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      if (items.some((value) => value.toLowerCase() === host)) continue;
      items.push(host);
    }
    process.env[key] = items.join(',');
  }
};

/** Node trusts its bundled roots only; a corporate TLS-inspecting proxy needs the system store. */
const useSystemCertificates = () => {
  try {
    tls.setDefaultCACertificates([
      ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
    ]);
  } catch (error) {
    console.warn(`[geocode-kernel] system certificates unavailable: ${error?.message ?? error}`);
  }
};

const useEnvironmentProxy = () => {
  try {
    http.setGlobalProxyFromEnv?.();
  } catch (error) {
    console.warn(`[geocode-kernel] proxy environment unavailable: ${error?.message ?? error}`);
  }
};

const parentPort = resolveParentPort();
let listener;
let starting = false;

const start = async (command) => {
  if (starting || listener) return;
  starting = true;
  try {
    applyCredential(command.password);
    ensureLoopbackBypassesProxy();
    useSystemCertificates();
    useEnvironmentProxy();

    const { Server } = await import(KERNEL_BUNDLE);
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      mdns: false,
      cors: [],
    });

    // The bound address, which the host connects the shell to rather than the one it requested.
    parentPort.postMessage(createReadyMessage({ hostname: listener.hostname, port: listener.port }));
  } catch (error) {
    parentPort.postMessage(createErrorMessage(error));
    setImmediate(() => process.exit(1));
  } finally {
    starting = false;
  }
};

const stop = async () => {
  try {
    await listener?.stop();
  } finally {
    listener = undefined;
    parentPort.postMessage(createStoppedMessage());
    setImmediate(() => process.exit(0));
  }
};

parentPort.on('message', (event) => {
  const command = parseKernelCommand(event?.data);
  if (!command) return;
  if (command.type === KERNEL_COMMAND.STOP) {
    void stop();
    return;
  }
  void start(command);
});

/* Node's default signal handling skips exit listeners, and the geo runtime's `killAllSync` sweep of QGIS children
 * is one (docs/GEOKERNEL.md §10.1 #8b); so a signal exits at once instead of awaiting `listener.stop()`. */
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => {
    process.exit(0);
  });
}
