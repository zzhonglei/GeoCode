// The main process's side of GeoEngine's message channel. Electron stays outside, in
// geoengine.mjs, so this runs under plain Node in the tests.

const READY_TIMEOUT_MS = 30_000;
// Above the engine's own worst case: 2 s of grace for its tasks, 5 s for their output, 2 s for its answers.
const SHUTDOWN_TIMEOUT_MS = 12_000;
const EXIT_WAIT_MS = 2_000;
const OUTPUT_TAIL = 16 * 1024;
const OUTPUT_WAIT_MS = 500;

const isId = (value) => Number.isInteger(value) && value > 0;
const isText = (value) => String(value) === value;

// Resolves with the promise's value, or with 'timeout' once ms have passed.
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), ms);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  });
});

/**
 * fork() returns a started utility process and throws when it cannot start one; an error with code
 * ENOENT means the engine is not where the app installed it. killTree(pid, { force }) ends a task the
 * engine left behind; when it leaves the task a grace period it returns a function that ends it at once.
 * onFailure(failure) runs once, when the engine could not start or died on its own.
 */
export const createSupervisor = ({
  fork,
  killTree,
  onFailure = () => {},
  log = console,
  readyTimeoutMs = READY_TIMEOUT_MS,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
}) => {
  // idle → starting → ready; starting or ready → failed; any → stopping → stopped
  let phase = 'idle';
  let child = null;
  let exited = Promise.resolve();
  let outputClosed = Promise.resolve();
  let failure = null;
  let readyTimer;
  let output = '';
  let nextId = 0;
  let stopping = null;
  let shutdownComplete = () => {};
  const pending = new Map();
  const queued = [];
  const tasks = new Set();
  const graceful = new Set();
  const statuses = new Map();
  const statusListeners = new Set();

  const post = (message) => {
    child.postMessage(message);
  };

  const settle = (id, outcome) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    outcome(entry);
  };

  const rejectAll = (error) => {
    queued.length = 0;
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(error));
  };

  // Forced while quitting: the app exits before any grace period could run out, including one already granted.
  const endTasks = ({ force }) => {
    for (const pid of tasks) {
      const endNow = killTree(pid, { force });
      if (endNow) graceful.add(endNow);
    }
    tasks.clear();
    if (!force) return;
    for (const endNow of graceful) endNow();
    graceful.clear();
  };

  const fail = (details) => {
    if (phase === 'failed') return;
    phase = 'failed';
    clearTimeout(readyTimer);
    failure = { ...details, output: output.trim() };
    log.error('[geoengine] failed:', failure);
    rejectAll(new Error(`GeoEngine is not available: ${failure.message}`));
    onFailure(failure);
  };

  const send = (id) => {
    const entry = pending.get(id);
    if (!entry) return;
    const message = { type: 'request', id, method: entry.method };
    if (entry.params !== undefined) message.params = entry.params;
    try {
      post(message);
      entry.sent = true;
    } catch (error) {
      settle(id, ({ reject }) => reject(error));
    }
  };

  const cancel = (id) => {
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.sent) {
      try {
        post({ type: 'cancel', id });
      } catch (error) {
        log.warn('[geoengine] could not send a cancel:', error);
      }
      return;
    }
    const position = queued.indexOf(id);
    if (position >= 0) queued.splice(position, 1);
    settle(id, ({ resolve }) => resolve({
      type: 'response',
      id,
      cancelled: true,
      ok: false,
      error: { code: 'cancelled', message: 'The request was cancelled before GeoEngine started it.' },
    }));
  };

  const onMessage = (message) => {
    // Stale once the engine has exited: a late task start would register a pid that may since be reused.
    if (!child) return;
    switch (message?.type) {
      case 'ready':
        if (phase !== 'starting') return;
        clearTimeout(readyTimer);
        phase = 'ready';
        for (const id of queued.splice(0)) send(id);
        return;
      case 'progress':
        if (isId(message.id)) pending.get(message.id)?.onProgress?.(message.data);
        return;
      case 'response':
        if (isId(message.id) && (message.ok === true || message.ok === false)) {
          settle(message.id, ({ resolve }) => resolve(message));
          return;
        }
        break;
      case 'status':
        if (isText(message.domain)) {
          statuses.set(message.domain, message.value);
          for (const listener of statusListeners) listener(message.domain, message.value);
          return;
        }
        break;
      case 'task':
        if (isId(message.pid) && (message.event === 'start' || message.event === 'end')) {
          if (message.event === 'start') tasks.add(message.pid);
          else tasks.delete(message.pid);
          return;
        }
        break;
      case 'shutdown-complete':
        shutdownComplete();
        return;
    }
    log.warn('[geoengine] unexpected message:', message);
  };

  const onExit = (code) => {
    child = null;
    clearTimeout(readyTimer);
    const quitting = phase === 'stopping' || phase === 'stopped';
    // The engine ends its own tasks unless it died first; whatever it still had registered is left to us.
    endTasks({ force: quitting });
    const starting = phase === 'starting';
    // The exit can overtake the engine's last error output, which is what the failure page has to show.
    void within(outputClosed, OUTPUT_WAIT_MS).then(() => {
      // A quit ends the engine on purpose, and may begin while its output is still arriving.
      if (phase === 'stopping' || phase === 'stopped') return;
      fail({
        reason: starting ? 'start' : 'exit',
        exitCode: code,
        message: `GeoEngine ${starting ? 'exited while starting' : 'exited unexpectedly'} with code ${code}.`,
      });
    });
  };

  const start = () => {
    if (phase !== 'idle') return;
    phase = 'starting';
    try {
      child = fork();
    } catch (error) {
      fail({ reason: error?.code === 'ENOENT' ? 'missing' : 'start', message: String(error?.message ?? error) });
      return;
    }
    const current = child;
    exited = new Promise((resolve) => current.once('exit', resolve));
    current.once('exit', onExit);
    current.on('message', onMessage);
    if (current.stderr) {
      const { stderr } = current;
      // Decoded as a stream, so a character split between chunks stays whole.
      stderr.setEncoding('utf8');
      outputClosed = new Promise((resolve) => {
        stderr.once('end', resolve);
        stderr.once('close', resolve);
      });
      stderr.on('data', (text) => {
        output = (output + text).slice(-OUTPUT_TAIL);
        log.warn('[geoengine]', text.trimEnd());
      });
    }
    readyTimer = setTimeout(() => {
      fail({ reason: 'start', message: `GeoEngine did not become ready within ${readyTimeoutMs} ms.` });
      current.kill();
    }, readyTimeoutMs);
  };

  /** Resolves with the engine's response; rejects when the engine is not there to answer. */
  const request = (method, params, { signal, onProgress } = {}) => new Promise((resolve, reject) => {
    if ((phase !== 'starting' && phase !== 'ready') || !child) {
      reject(new Error(failure ? `GeoEngine is not available: ${failure.message}` : 'GeoEngine is not running.'));
      return;
    }
    nextId += 1;
    const id = nextId;
    pending.set(id, { method, params, resolve, reject, onProgress, signal, onAbort: () => cancel(id), sent: false });
    if (phase === 'ready') send(id);
    else queued.push(id);
    if (signal?.aborted) cancel(id);
    else signal?.addEventListener('abort', pending.get(id).onAbort, { once: true });
  });

  /** Asks the engine to end its tasks and waits for it, within a limit, so quitting cannot hang on it. */
  const shutdown = () => {
    if (stopping) return stopping;
    const wasFailed = phase === 'failed';
    phase = 'stopping';
    clearTimeout(readyTimer);
    stopping = (async () => {
      const current = child;
      if (current && !wasFailed) {
        const completed = new Promise((resolve) => {
          shutdownComplete = () => resolve('complete');
        });
        try {
          current.postMessage({ type: 'shutdown' });
        } catch (error) {
          log.warn('[geoengine] could not ask for a shutdown:', error);
        }
        const outcome = await within(Promise.race([completed, exited.then(() => 'exit')]), shutdownTimeoutMs);
        if (outcome === 'timeout') log.warn('[geoengine] shutdown timed out; ending it');
      }
      if (child) child.kill();
      await within(exited, EXIT_WAIT_MS);
      endTasks({ force: true });
      rejectAll(new Error('GeoEngine has stopped.'));
      phase = 'stopped';
    })();
    return stopping;
  };

  return {
    start,
    request,
    shutdown,
    phase: () => phase,
    failure: () => failure,
    statuses: () => Object.fromEntries(statuses),
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
};
