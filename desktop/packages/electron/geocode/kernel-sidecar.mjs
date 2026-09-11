/* --- GeoCode: the entry that turns the Agent Kernel from a library into a process
 * (docs/DESKTOP.md §2.1).
 *
 * The kernel bundle exports `Server`; it has no main. Upstream opencode ships no consumer
 * of that bundle inside its own repository either, so this file is the consumer we owe it.
 * Everything the CLI's `serve` command would decide — which port, which credential, when to
 * stop — arrives instead over the utility process port, because Electron main owns those
 * decisions now.
 *
 * This file is STAGED, not imported: `prepare-geocode-kernel.mjs` copies it next to the
 * bundle it loads, together with the protocol module it shares with the host. That is what
 * lets the staged directory be started with a plain `node kernel-sidecar.mjs` and verified
 * without an Electron around it.
 *
 * The credential arrives over the port, not in the environment we were forked with, and is set
 * into this process's own environment because the kernel's server reads it only from there;
 * every process the kernel starts inherits it from here (docs/ENVIRONMENT.md §8). --- */

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

/**
 * Under Electron this is `process.parentPort`. Started directly from a shell there is no
 * parent, so a stdio port stands in and the same start/stop flow can be driven by hand.
 */
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
              // A line we cannot parse is not a command; ignoring it keeps a stray
              // console write from taking the kernel down.
            }
          }
          index = buffered.indexOf('\n');
        }
      });
    },
  };
};

const applyCredential = (password) => {
  process.env.OPENCODE_SERVER_USERNAME = SERVER_USERNAME;
  if (password) {
    process.env.OPENCODE_SERVER_PASSWORD = password;
    return;
  }
  delete process.env.OPENCODE_SERVER_PASSWORD;
};

/** A proxy that swallows loopback traffic would break the host's own health probe first. */
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

    // The bound port, not the requested one: the host asked for 0 and needs the answer.
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

/* A signal is the forcible path, not the polite one: it arrives when the host is already
 * on its way down, or when a `stop` went unanswered. So this exits at once instead of
 * awaiting the listener.
 *
 * Exiting IS the sweep. GeoKernel registers `process.on("exit", killAllSync)`
 * (geo/runtime/index.ts), and `process.exit` runs exit listeners synchronously — whereas
 * Node's default handling of SIGTERM terminates without running them at all, which is
 * exactly how a QGIS algorithm mid-run gets orphaned (GEOKERNEL.md §10.1 #8b). Closing the
 * HTTP listener first would only delay that sweep while the process is already dying; the
 * port is released by the kernel either way. */
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => {
    process.exit(0);
  });
}
