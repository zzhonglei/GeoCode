import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import { kernelConfigDir, kernelDataDir, kernelStateDir } from '@openchamber/web/server/geocode/kernel-paths.js';
import { withoutAppVariables, withoutDirectoryVariables } from '@openchamber/web/server/geocode/app-variables.js';
import { createEnvironmentStore } from '@openchamber/web/server/lib/environment/store.js';
import { overlayEnvironment } from '@openchamber/web/server/lib/environment/variables.js';
import { createSupervisor } from './geoengine-supervisor.mjs';

const MACHINE_FILE = 'machine.json';
const TASK_GRACE_MS = 3_000;

// The variables of Settings' environment page, which the kernel takes too, from the file the shell server's
// environmentStore keeps (web/server/index.js); read as the engine starts, so a change applies once the app restarts.
const settingsVariables = (log) => {
  try {
    return withoutDirectoryVariables(createEnvironmentStore({
      filePath: path.join(process.env.OPENCHAMBER_DATA_DIR, 'environment.json'),
    }).userVariables());
  } catch (error) {
    // As for the kernel: a file that cannot be read sets no variables, and the engine starts all the same.
    log.warn(`[geoengine] settings variables not applied: ${error.message}`);
    return {};
  }
};

// Staged by scripts/stage-geoengine.sh; inside app.asar once packaged.
const enginePath = () => path.join(app.getAppPath(), 'resources', 'geoengine', 'geoengine.mjs');

// Staged by scripts/stage-python.sh; beside app.asar once packaged: pixi-unpack cannot run, nor read, inside it.
const pythonBundlePath = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'python') : path.join(app.getAppPath(), 'resources', 'python');

const fork = (log) => {
  const modulePath = enginePath();
  if (!fs.existsSync(modulePath)) {
    throw Object.assign(new Error(`GeoEngine is missing at ${modulePath}.`), { code: 'ENOENT' });
  }
  // On a first launch the kernel, starting alongside, may not have made it yet, and the engine watches it.
  fs.mkdirSync(kernelConfigDir(), { recursive: true });
  const args = [
    `--machine=${path.join(kernelConfigDir(), MACHINE_FILE)}`,
    `--python=${pythonBundlePath()}`,
    // GeoCode's data directory, which the kernel shares.
    `--data=${kernelDataDir()}`,
    // And its state directory, among whose lock files the OSM tools keep when Nominatim was last asked.
    `--state=${kernelStateDir()}`,
  ];
  return utilityProcess.fork(modulePath, args, {
    serviceName: 'GeoEngine',
    env: withoutAppVariables(overlayEnvironment(process.env, settingsVariables(log))),
    stdio: ['ignore', 'inherit', 'pipe'],
  });
};

// A registered pid leads its task's process group on POSIX. Windows has no groups, so the tree goes by pid,
// which the engine registers only while the task runs. Given a grace period, returns what ends it at once.
export const killTree = (pid, { force }) => {
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  if (force) {
    signal('SIGKILL');
    return;
  }
  signal('SIGTERM');
  let ended = false;
  const endNow = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal('SIGKILL');
  };
  const timer = setTimeout(endNow, TASK_GRACE_MS);
  timer.unref();
  return endNow;
};

let supervisor = null;
let stopped = false;
const statusListeners = new Set();

/** Starts GeoEngine once per launch; onFailure runs if it cannot start or dies on its own. */
export const startGeoEngine = ({ log, onFailure }) => {
  // A quit can come before startup gets this far.
  if (stopped) return;
  if (!supervisor) {
    supervisor = createSupervisor({ fork: () => fork(log), killTree, log, onFailure });
    supervisor.onStatus((domain, value) => {
      for (const listener of statusListeners) listener(domain, value);
    });
  }
  supervisor.start();
};

/** Resolves with GeoEngine's response; rejects when it is not there to answer. */
export const geoEngineRequest = (method, params, options) =>
  supervisor ? supervisor.request(method, params, options) : Promise.reject(new Error('GeoEngine has not started.'));

/** The latest status of each domain, empty until GeoEngine reports one. */
export const geoEngineStatuses = () => supervisor?.statuses() ?? {};

// Taken before GeoEngine starts too: the shell server can start first.
export const onGeoEngineStatus = (listener) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

export const stopGeoEngine = () => {
  stopped = true;
  return supervisor?.shutdown() ?? Promise.resolve();
};

export const geoEngineFailure = () => supervisor?.failure() ?? null;
